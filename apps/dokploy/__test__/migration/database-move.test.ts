import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `moveDatabaseToServer` pulls in a large dependency graph (six database
 * service modules, docker utils, filesystem helpers, the migration store,
 * ...). Every one of those is mocked here so these tests exercise only the
 * orchestration logic in `database-move.ts` itself - in particular the two
 * safety fixes this file covers:
 *
 * 1. Target-runtime rollback ownership (TOCTOU): rollback must only remove
 *    the target Docker service once `adapter.deploy` has POSITIVELY
 *    succeeded, never merely because it was attempted - and a fresh
 *    collision check runs immediately before `deploy` to shrink the window
 *    opened by the (potentially long) volume/file transfer.
 * 2. Source-restart gating: rollback must attempt to restart the source
 *    based on whether the stop was *requested*, not on whether it was
 *    *verified* - a verification failure (SSH error, timeout) must not
 *    suppress the restart attempt.
 */
const postgresMocks = vi.hoisted(() => ({
	findPostgresById: vi.fn(),
	updatePostgresById: vi.fn(),
	deployPostgres: vi.fn(),
}));
vi.mock("@dokploy/server/services/postgres", () => postgresMocks);

// The other five database adapters are wired up eagerly at module load
// (the `adapters` record in database-move.ts), so they must be mockable
// even though these tests only ever exercise the "postgres" service type.
vi.mock("@dokploy/server/services/mysql", () => ({
	findMySqlById: vi.fn(),
	updateMySqlById: vi.fn(),
	deployMySql: vi.fn(),
}));
vi.mock("@dokploy/server/services/mariadb", () => ({
	findMariadbById: vi.fn(),
	updateMariadbById: vi.fn(),
	deployMariadb: vi.fn(),
}));
vi.mock("@dokploy/server/services/mongo", () => ({
	findMongoById: vi.fn(),
	updateMongoById: vi.fn(),
	deployMongo: vi.fn(),
}));
vi.mock("@dokploy/server/services/redis", () => ({
	findRedisById: vi.fn(),
	updateRedisById: vi.fn(),
	deployRedis: vi.fn(),
}));
vi.mock("@dokploy/server/services/libsql", () => ({
	findLibsqlById: vi.fn(),
	updateLibsqlById: vi.fn(),
	deployLibsql: vi.fn(),
}));

vi.mock("@dokploy/server/services/server", () => ({
	getAccessibleServerIds: vi.fn(),
}));

const storeMocks = vi.hoisted(() => ({
	createPendingServiceMigration: vi.fn(),
	finalizeServiceMigration: vi.fn(),
	findPendingServiceMigration: vi.fn(),
	findServiceMigrationById: vi.fn(),
	getMigrationServiceId: vi.fn(),
	markServiceMigrationRollingBack: vi.fn(),
}));
vi.mock("@dokploy/server/services/service-migration-store", () => storeMocks);

const dockerUtilsMocks = vi.hoisted(() => ({
	startService: vi.fn(),
	startServiceRemote: vi.fn(),
	stopService: vi.fn(),
	stopServiceRemote: vi.fn(),
}));
vi.mock("@dokploy/server/utils/docker/utils", () => dockerUtilsMocks);

vi.mock("@dokploy/server/utils/filesystem/directory", () => ({
	removeDirectoryCode: vi.fn(),
	removeMonitoringDirectory: vi.fn(),
}));

const cleanupMocks = vi.hoisted(() => ({
	removeServiceIdempotent: vi.fn(),
	removeVolumeIdempotent: vi.fn(),
}));
vi.mock("@dokploy/server/utils/migration/cleanup", () => cleanupMocks);

const rollbackOutcomeMocks = vi.hoisted(() => ({
	resolveServiceMigrationAfterRollback: vi.fn(),
}));
vi.mock(
	"@dokploy/server/utils/migration/rollback-outcome",
	() => rollbackOutcomeMocks,
);

const runtimeMocks = vi.hoisted(() => ({
	countRunningContainers: vi.fn(),
	runtimeExistsOnTarget: vi.fn(),
}));
vi.mock("@dokploy/server/utils/migration/runtime", () => runtimeMocks);

vi.mock("@dokploy/server/utils/migration/transfer", () => ({
	transferDirectory: vi.fn(),
	transferDockerVolume: vi.fn(),
}));

vi.mock("@dokploy/server/utils/migration/validate-target-service", () => ({
	validateMoveTarget: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	sleep: vi.fn().mockResolvedValue(undefined),
}));

import { moveDatabaseToServer } from "@dokploy/server/services/database-move";

const SOURCE_SERVER_ID = null; // local source
const TARGET_SERVER_ID = "server-target";

const baseEntity = {
	appName: "my-postgres-app",
	serverId: SOURCE_SERVER_ID,
	networkIds: [],
	applicationStatus: "running",
	mounts: [] as unknown[],
	environment: { project: { organizationId: "org-1" } },
};

describe("moveDatabaseToServer", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		postgresMocks.findPostgresById.mockResolvedValue({ ...baseEntity });
		postgresMocks.updatePostgresById.mockResolvedValue(undefined);
		storeMocks.createPendingServiceMigration.mockResolvedValue({
			serviceMigrationId: "mig_1",
		});
		storeMocks.markServiceMigrationRollingBack.mockResolvedValue(undefined);
		rollbackOutcomeMocks.resolveServiceMigrationAfterRollback.mockResolvedValue(
			new Error("rolled back"),
		);
		dockerUtilsMocks.stopService.mockResolvedValue(undefined);
		dockerUtilsMocks.startService.mockResolvedValue(undefined);
		// Source is confirmed stopped (0 running containers on the source);
		// target defaults to "never comes up" unless a test overrides it.
		runtimeMocks.countRunningContainers.mockImplementation(
			async (_kind: string, _appName: string, serverId: string | null) =>
				serverId === TARGET_SERVER_ID ? 0 : 0,
		);
		// No pre-existing collision, and none appears mid-move either, unless
		// a test overrides this.
		runtimeMocks.runtimeExistsOnTarget.mockResolvedValue(false);
	});

	it("does NOT remove the target service when adapter.deploy() throws before ownership is established (TOCTOU safety)", async () => {
		postgresMocks.deployPostgres.mockRejectedValue(
			new Error("deploy exploded"),
		);

		await expect(
			moveDatabaseToServer({
				serviceType: "postgres",
				id: "pg_1",
				targetServerId: TARGET_SERVER_ID,
				session: { userId: "u1", activeOrganizationId: "org-1" },
			}),
		).rejects.toThrow("rolled back");

		expect(postgresMocks.deployPostgres).toHaveBeenCalledTimes(1);
		// Ownership was never established (deploy threw) - the target service
		// must NOT be touched by rollback.
		expect(cleanupMocks.removeServiceIdempotent).not.toHaveBeenCalled();

		expect(
			rollbackOutcomeMocks.resolveServiceMigrationAfterRollback,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				serviceMigrationId: "mig_1",
				cleanupErrors: [],
			}),
		);
	});

	it("refuses to deploy - and never removes anything on the target - when a same-name collision appears mid-transfer (recheck immediately before deploy)", async () => {
		// Preflight check (very first call) finds nothing; the recheck
		// immediately before `deploy` finds a collision that appeared while
		// data was being transferred.
		runtimeMocks.runtimeExistsOnTarget
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true);

		await expect(
			moveDatabaseToServer({
				serviceType: "postgres",
				id: "pg_1",
				targetServerId: TARGET_SERVER_ID,
				session: { userId: "u1", activeOrganizationId: "org-1" },
			}),
		).rejects.toThrow("rolled back");

		// `adapter.deploy` must never be called once the recheck finds a
		// collision - this migration cannot safely establish ownership.
		expect(postgresMocks.deployPostgres).not.toHaveBeenCalled();
		expect(cleanupMocks.removeServiceIdempotent).not.toHaveBeenCalled();
	});

	it("removes the target service once adapter.deploy() succeeds, even if the post-deploy running-check later fails", async () => {
		postgresMocks.deployPostgres.mockResolvedValue(undefined);
		// Target never reports a running container - post-deploy verification
		// fails, but ownership was already established by the successful
		// deploy, so rollback must remove it.
		runtimeMocks.countRunningContainers.mockImplementation(
			async (_kind: string, _appName: string, serverId: string | null) =>
				serverId === TARGET_SERVER_ID ? 0 : 0,
		);

		await expect(
			moveDatabaseToServer({
				serviceType: "postgres",
				id: "pg_1",
				targetServerId: TARGET_SERVER_ID,
				session: { userId: "u1", activeOrganizationId: "org-1" },
			}),
		).rejects.toThrow("rolled back");

		expect(postgresMocks.deployPostgres).toHaveBeenCalledTimes(1);
		expect(cleanupMocks.removeServiceIdempotent).toHaveBeenCalledWith(
			"my-postgres-app",
			TARGET_SERVER_ID,
		);
	});

	it("attempts to restart the source when stop was REQUESTED but verification fails (SSH failure), not just when it was verified stopped", async () => {
		// `stopDatabaseService` itself succeeds (the stop was requested and
		// dispatched), but the subsequent verification poll fails outright
		// (e.g. a dead SSH connection) rather than timing out.
		runtimeMocks.countRunningContainers.mockRejectedValue(
			new Error("ECONNREFUSED: dead ssh connection"),
		);

		await expect(
			moveDatabaseToServer({
				serviceType: "postgres",
				id: "pg_1",
				targetServerId: TARGET_SERVER_ID,
				session: { userId: "u1", activeOrganizationId: "org-1" },
			}),
		).rejects.toThrow("rolled back");

		// The stop was requested before the failed verification, so the
		// restart must still be attempted.
		expect(dockerUtilsMocks.startService).toHaveBeenCalledTimes(1);
		// deploy was never reached - the failure happened during the source
		// stop/verify phase - so nothing on the target was ever touched.
		expect(postgresMocks.deployPostgres).not.toHaveBeenCalled();
		expect(cleanupMocks.removeServiceIdempotent).not.toHaveBeenCalled();

		const restartErrorArg =
			rollbackOutcomeMocks.resolveServiceMigrationAfterRollback.mock
				.calls[0]?.[0];
		expect(restartErrorArg.restartError).toBeNull();
	});

	it("does not attempt a source restart at all when the stop was never requested (failure before the stop is even invoked)", async () => {
		const { validateMoveTarget } = await import(
			"@dokploy/server/utils/migration/validate-target-service"
		);
		vi.mocked(validateMoveTarget).mockRejectedValueOnce(
			new Error("invalid target"),
		);

		await expect(
			moveDatabaseToServer({
				serviceType: "postgres",
				id: "pg_1",
				targetServerId: TARGET_SERVER_ID,
				session: { userId: "u1", activeOrganizationId: "org-1" },
			}),
		).rejects.toThrow("invalid target");

		// Failure happened before the pending-migration row (and thus before
		// the try/catch rollback path) was even created - nothing to restart,
		// nothing to roll back.
		expect(dockerUtilsMocks.startService).not.toHaveBeenCalled();
		expect(
			rollbackOutcomeMocks.resolveServiceMigrationAfterRollback,
		).not.toHaveBeenCalled();
	});
});
