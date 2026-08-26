import path from "node:path";
import { paths } from "@dokploy/server/constants";
import {
	findComposeById,
	stopCompose,
	updateCompose,
} from "@dokploy/server/services/compose";
import {
	createDeploymentCompose,
	updateDeploymentStatus,
} from "@dokploy/server/services/deployment";
import { getAccessibleServerIds } from "@dokploy/server/services/server";
import {
	createPendingServiceMigration,
	finalizeServiceMigration,
	findPendingServiceMigration,
	findServiceMigrationById,
	markServiceMigrationRollingBack,
} from "@dokploy/server/services/service-migration-store";
import {
	removeComposeDirectory,
	removeMonitoringDirectory,
} from "@dokploy/server/utils/filesystem/directory";
import {
	isMissingResourceError,
	removeVolumeIdempotent,
} from "@dokploy/server/utils/migration/cleanup";
import {
	execAsync,
	execAsyncRemote,
	sleep,
} from "@dokploy/server/utils/process/execAsync";
import { TRPCError } from "@trpc/server";
import { quote } from "shell-quote";
import { findUnsafeBindMounts } from "../utils/migration/bind-safety";
import {
	buildInspectMountsCommand,
	buildListComposeContainerIdsCommand,
	parseComposeMountsOutput,
} from "../utils/migration/compose-mounts";
import { buildComposeServerMoveDescription } from "../utils/migration/move-metadata";
import { resolveServiceMigrationAfterRollback } from "../utils/migration/rollback-outcome";
import {
	countRunningContainers,
	runtimeExistsOnTarget,
} from "../utils/migration/runtime";
import {
	transferDirectory,
	transferDockerVolume,
} from "../utils/migration/transfer";
import { validateMoveTarget } from "../utils/migration/validate-target-service";

const getComposeProjectDirectory = (
	appName: string,
	serverId: string | null,
) => {
	const { COMPOSE_PATH } = paths(!!serverId);
	return path.join(COMPOSE_PATH, appName);
};

const discoverComposeMounts = async (
	appName: string,
	composeType: "docker-compose" | "stack",
	serverId: string | null,
) => {
	const listCommand = buildListComposeContainerIdsCommand(appName, composeType);
	const { stdout: idsOutput } = serverId
		? await execAsyncRemote(serverId, listCommand)
		: await execAsync(listCommand);

	const containerIds = idsOutput
		.trim()
		.split("\n")
		.map((id) => id.trim())
		.filter(Boolean);

	if (containerIds.length === 0) {
		return { volumes: [], binds: [] };
	}

	const inspectCommand = buildInspectMountsCommand(containerIds);
	const { stdout: mountsOutput } = serverId
		? await execAsyncRemote(serverId, inspectCommand)
		: await execAsync(inspectCommand);

	return parseComposeMountsOutput(mountsOutput);
};

/** Runs `docker compose up -d` (docker-compose) or `docker stack deploy` (stack) against the already-transferred project files, without re-cloning/re-building from source. */
const startComposeFromExistingFiles = async ({
	appName,
	composeType,
	sourceType,
	composePath,
	serverId,
}: {
	appName: string;
	composeType: "docker-compose" | "stack";
	sourceType: string;
	composePath: string;
	serverId: string | null;
}) => {
	const { COMPOSE_PATH } = paths(!!serverId);
	const projectPath = path.join(COMPOSE_PATH, appName, "code");
	const composeFilePath =
		sourceType === "raw" ? "docker-compose.yml" : composePath;

	const command =
		composeType === "stack"
			? `docker stack deploy -c ${quote([composeFilePath])} ${quote([appName])} --prune --with-registry-auth`
			: `env -i PATH="$PATH" docker compose -p ${quote([appName])} -f ${quote([composeFilePath])} up -d`;

	const wrapped = `cd ${quote([projectPath])} && ${command}`;

	if (serverId) {
		await execAsyncRemote(serverId, wrapped);
	} else {
		await execAsync(wrapped, { cwd: projectPath });
	}
};

const POLL_ATTEMPTS = 10;
const POLL_INTERVAL_MS = 2000;

/**
 * Polls until at least one running container is found for the compose
 * project/stack. Uses `countRunningContainers` (strict, throws on SSH/
 * Docker inspection failure) rather than `getContainersByAppNameMatch`
 * (which swallows errors and returns `[]`) - an inspection failure here
 * must abort the move, not be silently treated as "not running yet".
 */
const verifyComposeIsRunning = async ({
	appName,
	composeType,
	serverId,
}: {
	appName: string;
	composeType: "docker-compose" | "stack";
	serverId: string | null;
}): Promise<boolean> => {
	for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
		const runningCount = await countRunningContainers(
			composeType,
			appName,
			serverId,
		);
		if (runningCount > 0) return true;
		await sleep(POLL_INTERVAL_MS);
	}
	return false;
};

/**
 * Polls until no container of the compose project/stack reports a "running"
 * state. Called right after `stopCompose` to make sure the maintenance
 * window has actually taken effect before the volumes/project directory are
 * tar'd up - `docker compose stop`/`docker stack rm` both return before every
 * container has necessarily finished draining.
 *
 * Uses `countRunningContainers` (strict, throws on SSH/Docker inspection
 * failure) rather than `getContainersByAppNameMatch` (which swallows errors
 * and returns `[]`) - an inspection failure means the true state is
 * unknown, and must never be silently treated as "confirmed stopped", or
 * data that is still being written could be copied out from under the
 * source.
 */
const verifyComposeIsStopped = async ({
	appName,
	composeType,
	serverId,
}: {
	appName: string;
	composeType: "docker-compose" | "stack";
	serverId: string | null;
}): Promise<boolean> => {
	for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
		const runningCount = await countRunningContainers(
			composeType,
			appName,
			serverId,
		);
		if (runningCount === 0) return true;
		await sleep(POLL_INTERVAL_MS);
	}
	return false;
};

/**
 * Tears down a compose project/stack's running containers, without touching
 * its volumes. Treats "already gone" (no such stack/project) as success -
 * this must be safely retryable since it is used both for rolling back a
 * failed move on the target and for finalizing a completed one on the
 * source.
 */
const removeComposeRuntime = async (
	appName: string,
	composeType: "docker-compose" | "stack",
	serverId: string | null,
) => {
	const disconnectCommand = `docker network disconnect ${quote([appName])} dokploy-traefik`;
	const stopCommand =
		composeType === "stack"
			? `docker stack rm ${quote([appName])}`
			: `env -i PATH="$PATH" docker compose -p ${quote([appName])} down`;
	const command = `${disconnectCommand} 2>/dev/null; ${stopCommand}`;
	try {
		if (serverId) {
			await execAsyncRemote(serverId, command);
		} else {
			await execAsync(command);
		}
	} catch (error) {
		if (isMissingResourceError(error)) return;
		throw error;
	}
};

/**
 * Full data-migrating cross-server move for a Compose service. Stops the
 * source (maintenance window), transfers the compose project directory
 * (`/etc/dokploy/compose/<appName>`, which also carries any bind-mounted
 * data that lives inside it) and every named Docker volume it uses, then
 * starts the (already-built) stack/project on the target using the
 * transferred files. The source is left stopped with its volumes intact
 * until `finalizeComposeMove` is called.
 *
 * A durable "pending move" record (shared with the database move feature)
 * is persisted BEFORE the source is touched at all: it is both the
 * exclusive lock preventing a second concurrent move for the same compose
 * service, and the recovery record every failure path below rolls back
 * against. It also durably stores the discovered volume names, because they
 * can no longer be rediscovered from running containers once the source
 * stack/project has been removed by `finalizeComposeMove`.
 */
export const moveComposeToServer = async ({
	composeId,
	targetServerId,
	session,
}: {
	composeId: string;
	targetServerId: string | null;
	session: { userId: string; activeOrganizationId: string };
}) => {
	const compose = await findComposeById(composeId);
	const sourceServerId = compose.serverId;
	const normalizedTargetServerId = targetServerId || null;
	const composeType = compose.composeType as "docker-compose" | "stack";

	await validateMoveTarget({
		session,
		sourceServerId,
		targetServerId: normalizedTargetServerId,
	});

	// Strict, dedicated "is this compose service actually running" check -
	// deliberately separate from mount discovery below. A stateless compose
	// service (no named volumes, no bind mounts) has nothing to transfer but
	// is still perfectly moveable as long as it's running; conflating "no
	// mounts were discovered" with "nothing is running" would wrongly reject
	// that case.
	const runningContainerCount = await countRunningContainers(
		composeType,
		compose.appName,
		sourceServerId,
	);
	if (runningContainerCount === 0) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message:
				"No running containers were found for this compose service. Deploy it before moving it to another server.",
		});
	}

	const discovered = await discoverComposeMounts(
		compose.appName,
		composeType,
		sourceServerId,
	);

	const projectDirectory = getComposeProjectDirectory(
		compose.appName,
		sourceServerId,
	);
	const unsafeBinds = findUnsafeBindMounts(discovered.binds, projectDirectory);
	if (unsafeBinds.length > 0) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: `This compose service binds host paths outside its managed project directory, which cannot be safely copied to another server: ${unsafeBinds
				.map((mount) => `${mount.source} -> ${mount.destination}`)
				.join(", ")}`,
		});
	}

	// Target runtime name collision preflight: refuse the move outright if a
	// project/stack with this appName already exists on the target - BEFORE
	// any side effect (before the lock row, before stopping the source).
	// Without this, a same-name collision (e.g. a leftover/orphaned
	// stack/project, or a previous failed move that didn't fully clean up)
	// would only be discovered once the rollback path unconditionally tried
	// to tear down "the target runtime", which could touch something this
	// move never created.
	const targetHasCollidingRuntime = await runtimeExistsOnTarget(
		composeType,
		compose.appName,
		normalizedTargetServerId,
	);
	if (targetHasCollidingRuntime) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: `A compose ${composeType === "stack" ? "stack" : "project"} named "${compose.appName}" already exists on the target server. Refusing to move onto a colliding name - remove or rename it first.`,
		});
	}

	const originalServiceNetworks = compose.serviceNetworks ?? [];
	const volumeNames = discovered.volumes.map((volume) => volume.name);

	// The durable "pending move" record is the exclusive lock for this move:
	// its partial unique index (scoped to this compose service's id, status =
	// 'pending') makes a concurrent second move fail atomically at the
	// database level. It also durably captures `volumeNames` discovered while
	// the source was still running, for `finalizeComposeMove` to use later.
	const migrationRow = await createPendingServiceMigration({
		serviceType: "compose",
		id: composeId,
		sourceServerId,
		targetServerId: normalizedTargetServerId,
		volumeNames,
	});

	// Set true right before `stopCompose` is invoked - i.e. before we even
	// know whether the stop command itself, or the subsequent verification
	// poll, will succeed. Rollback's decision to attempt a source restart
	// must key off of this ("did we ask the source to stop?"), never off of
	// "did we *confirm* it stopped" - a verification timeout or an SSH
	// failure partway through `verifyComposeIsStopped` still means the stop
	// was requested and may well have taken effect, so the source must still
	// be restarted on any later failure.
	let sourceStopRequested = false;
	let createdProjectDirectory = false;
	const createdVolumes: string[] = [];
	let ownershipMoved = false;
	// Set only once `startComposeFromExistingFiles` has returned WITHOUT
	// throwing - i.e. ownership of a runtime under `compose.appName` on the
	// target has been positively established, not merely attempted. This
	// must never be widened to "start was invoked": the preflight collision
	// check above only proves the name was free *before* the (potentially
	// long-running) directory/volume transfer started, not at the moment
	// `startComposeFromExistingFiles` runs. If it throws before this flips
	// true, rollback must NOT tear down anything under this name on the
	// target - safety over automatic cleanup, and conservative non-removal
	// is acceptable here - leaving the migration `failed` with an actionable
	// error for manual/retry cleanup instead.
	let targetStartSucceeded = false;
	try {
		// Maintenance window: stop the source and confirm it actually drained
		// before copying, so volume/bind data on disk is consistent while we
		// tar it up.
		sourceStopRequested = true;
		await stopCompose(composeId);
		const stopped = await verifyComposeIsStopped({
			appName: compose.appName,
			composeType,
			serverId: sourceServerId,
		});
		if (!stopped) {
			throw new Error(
				"The source compose service did not stop within the expected time - refusing to copy data that may still be changing",
			);
		}

		await transferDirectory({
			sourceServerId,
			sourcePath: projectDirectory,
			targetServerId: normalizedTargetServerId,
			targetPath: getComposeProjectDirectory(
				compose.appName,
				normalizedTargetServerId,
			),
			onTargetCreated: () => {
				createdProjectDirectory = true;
			},
		});

		for (const volume of discovered.volumes) {
			await transferDockerVolume({
				sourceServerId,
				sourceVolumeName: volume.name,
				targetServerId: normalizedTargetServerId,
				targetVolumeName: volume.name,
				onTargetCreated: () => {
					createdVolumes.push(volume.name);
				},
			});
		}

		await updateCompose(composeId, {
			serverId: normalizedTargetServerId,
			serviceNetworks: [],
		});
		ownershipMoved = true;

		// Re-check for a name collision immediately before starting, not just
		// once at the very start of this function: the directory/volume
		// transfer above can take a long time, during which another process
		// could have created a same-name project/stack on the target.
		// Re-confirming absence here shrinks (it cannot fully eliminate) that
		// TOCTOU window, and - combined with `targetStartSucceeded` only
		// flipping true after `startComposeFromExistingFiles` returns without
		// throwing - means rollback can only ever tear down a runtime this
		// migration itself is responsible for.
		const collisionAppeared = await runtimeExistsOnTarget(
			composeType,
			compose.appName,
			normalizedTargetServerId,
		);
		if (collisionAppeared) {
			throw new Error(
				`A compose ${composeType === "stack" ? "stack" : "project"} named "${compose.appName}" appeared on the target server while data was being transferred. Refusing to start onto it - this migration cannot safely establish ownership.`,
			);
		}

		await startComposeFromExistingFiles({
			appName: compose.appName,
			composeType,
			sourceType: compose.sourceType,
			composePath: compose.composePath,
			serverId: normalizedTargetServerId,
		});
		targetStartSucceeded = true;

		const isRunning = await verifyComposeIsRunning({
			appName: compose.appName,
			composeType,
			serverId: normalizedTargetServerId,
		});
		if (!isRunning) {
			throw new Error(
				"The compose service did not report a running container on the target server",
			);
		}

		// Purely informational log entry - the durable service_migration row
		// (not this deployment) is authoritative for pending/finalized state,
		// so it is safe even if Compose's deployment history is later pruned.
		const deployment = await createDeploymentCompose({
			composeId,
			title: "Move to another server",
			description: buildComposeServerMoveDescription({
				type: "server-move",
				status: "pending",
				sourceServerId,
				targetServerId: normalizedTargetServerId,
			}),
		});
		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updateCompose(composeId, { composeStatus: "done" });
	} catch (error) {
		// Durably mark the row as rolling-back BEFORE attempting any rollback
		// side effect, so a crash mid-rollback leaves clear evidence instead
		// of an orphaned "pending" row that looks like a healthy in-flight
		// move.
		await markServiceMigrationRollingBack(
			migrationRow.serviceMigrationId,
		).catch((markError) => {
			console.error(
				"Failed to mark service migration as rolling back",
				markError,
			);
		});

		// Only ever attempt to tear down "the target runtime" once ownership
		// has been positively established - see `targetStartSucceeded`'s doc
		// comment above. If `startComposeFromExistingFiles` never returned
		// successfully, this migration cannot prove it created (or even
		// touched) anything under this name on the target, so it must NOT be
		// torn down here: safety over automatic cleanup. For Compose in
		// particular, conservative non-removal is acceptable - this leaves the
		// row `failed` (below) with an actionable error, and the target
		// artifacts in place for manual inspection/retry, rather than risking
		// tearing down a project/stack this migration never owned.
		const cleanupResults = await Promise.allSettled([
			targetStartSucceeded
				? removeComposeRuntime(
						compose.appName,
						composeType,
						normalizedTargetServerId,
					)
				: Promise.resolve(),
			createdProjectDirectory
				? removeComposeDirectory(
						compose.appName,
						normalizedTargetServerId ?? undefined,
					)
				: Promise.resolve(),
			...createdVolumes.map((volumeName) =>
				removeVolumeIdempotent(volumeName, normalizedTargetServerId),
			),
		]);
		const cleanupErrors = cleanupResults
			.filter(
				(result): result is PromiseRejectedResult =>
					result.status === "rejected",
			)
			.map((result) => result.reason);
		for (const cleanupError of cleanupErrors) {
			console.error(
				"Failed to clean up target after compose move rollback",
				cleanupError,
			);
		}

		// Restart the source BEFORE deciding what composeStatus to report:
		// only once we know it actually came back up can the record
		// truthfully claim "done" again. `restartError` is propagated into
		// the thrown error below rather than only logged, so a caller isn't
		// told the move simply failed while the source silently failed to
		// come back up too.
		//
		// Gated on `sourceStopRequested` (the stop was *asked for*), not on
		// having *verified* the stop - a verification timeout or an SSH
		// failure inside `verifyComposeIsStopped` still means `stopCompose`
		// was already invoked and may well have taken effect, so the source
		// must still be restarted here regardless of whether that
		// verification itself ever completed.
		let restartError: unknown = null;
		if (sourceStopRequested) {
			try {
				await startComposeFromExistingFiles({
					appName: compose.appName,
					composeType,
					sourceType: compose.sourceType,
					composePath: compose.composePath,
					serverId: sourceServerId,
				});
			} catch (err) {
				restartError = err;
				console.error("Failed to restart source compose after rollback", err);
			}
		}

		await updateCompose(composeId, {
			serverId: sourceServerId,
			serviceNetworks: originalServiceNetworks,
			...(sourceStopRequested
				? { composeStatus: restartError ? "error" : "done" }
				: {}),
		});

		// Only deletes the durable lock row once cleanup AND the source
		// restart both fully succeeded; otherwise it is retained as `failed`
		// with a recoverable error describing what needs manual attention.
		const rollbackError = await resolveServiceMigrationAfterRollback({
			serviceMigrationId: migrationRow.serviceMigrationId,
			originalError: error,
			cleanupErrors,
			restartError,
		});
		throw rollbackError;
	}

	return {
		migrationId: migrationRow.serviceMigrationId,
		sourceServerId,
		targetServerId: normalizedTargetServerId,
	};
};

export const getPendingComposeMove = async (composeId: string) => {
	const migration = await findPendingServiceMigration("compose", composeId);
	if (!migration) return null;
	return {
		migrationId: migration.serviceMigrationId,
		sourceServerId: migration.sourceServerId,
		targetServerId: migration.targetServerId,
	};
};

/**
 * Removes the source runtime/project directory/volumes for a completed
 * compose move, after the caller has validated the target. Requires the
 * persisted "pending" service_migration record so a client can never trigger
 * cleanup of a server it merely claims was the source. Uses the volume names
 * persisted at move time (not rediscovery, which would fail once the source
 * stack/project no longer exists). Every cleanup step must succeed (missing
 * resources count as already-clean/success; real errors throw) before the
 * record is marked finalized, so this is always safe to retry.
 */
export const finalizeComposeMove = async ({
	composeId,
	migrationId,
	session,
}: {
	composeId: string;
	migrationId: string;
	session: { userId: string; activeOrganizationId: string };
}) => {
	const compose = await findComposeById(composeId);
	const migration = await findServiceMigrationById(migrationId);

	if (
		migration?.status !== "pending" ||
		migration.composeId !== composeId ||
		migration.targetServerId !== compose.serverId
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"This move record is not a pending move for this compose service",
		});
	}

	if (migration.sourceServerId) {
		const accessibleIds = await getAccessibleServerIds(session);
		if (!accessibleIds.has(migration.sourceServerId)) {
			throw new TRPCError({
				code: "UNAUTHORIZED",
				message: "You are not authorized to clean up the source server",
			});
		}
	}

	await removeComposeRuntime(
		compose.appName,
		compose.composeType as "docker-compose" | "stack",
		migration.sourceServerId,
	);

	await removeComposeDirectory(
		compose.appName,
		migration.sourceServerId ?? undefined,
	);
	await removeMonitoringDirectory(
		compose.appName,
		migration.sourceServerId ?? undefined,
	);

	for (const volumeName of migration.volumeNames) {
		await removeVolumeIdempotent(volumeName, migration.sourceServerId);
	}

	await finalizeServiceMigration(migrationId);

	return true;
};
