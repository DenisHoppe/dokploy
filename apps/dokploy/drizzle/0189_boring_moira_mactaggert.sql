CREATE TYPE "public"."serviceMigrationStatus" AS ENUM('pending', 'finalized', 'rolling_back', 'failed');--> statement-breakpoint
CREATE TABLE "service_migration" (
	"serviceMigrationId" text PRIMARY KEY NOT NULL,
	"serviceType" "serviceType" NOT NULL,
	"status" "serviceMigrationStatus" DEFAULT 'pending' NOT NULL,
	"sourceServerId" text,
	"targetServerId" text,
	"postgresId" text,
	"mysqlId" text,
	"mariadbId" text,
	"mongoId" text,
	"redisId" text,
	"libsqlId" text,
	"composeId" text,
	"volumeNames" text[] DEFAULT '{}' NOT NULL,
	"createdAt" text NOT NULL,
	"finalizedAt" text,
	"error" text,
	"failedAt" text
);
--> statement-breakpoint
ALTER TABLE "service_migration" ADD CONSTRAINT "service_migration_sourceServerId_server_serverId_fk" FOREIGN KEY ("sourceServerId") REFERENCES "public"."server"("serverId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_migration" ADD CONSTRAINT "service_migration_targetServerId_server_serverId_fk" FOREIGN KEY ("targetServerId") REFERENCES "public"."server"("serverId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_migration" ADD CONSTRAINT "service_migration_postgresId_postgres_postgresId_fk" FOREIGN KEY ("postgresId") REFERENCES "public"."postgres"("postgresId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_migration" ADD CONSTRAINT "service_migration_mysqlId_mysql_mysqlId_fk" FOREIGN KEY ("mysqlId") REFERENCES "public"."mysql"("mysqlId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_migration" ADD CONSTRAINT "service_migration_mariadbId_mariadb_mariadbId_fk" FOREIGN KEY ("mariadbId") REFERENCES "public"."mariadb"("mariadbId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_migration" ADD CONSTRAINT "service_migration_mongoId_mongo_mongoId_fk" FOREIGN KEY ("mongoId") REFERENCES "public"."mongo"("mongoId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_migration" ADD CONSTRAINT "service_migration_redisId_redis_redisId_fk" FOREIGN KEY ("redisId") REFERENCES "public"."redis"("redisId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_migration" ADD CONSTRAINT "service_migration_libsqlId_libsql_libsqlId_fk" FOREIGN KEY ("libsqlId") REFERENCES "public"."libsql"("libsqlId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_migration" ADD CONSTRAINT "service_migration_composeId_compose_composeId_fk" FOREIGN KEY ("composeId") REFERENCES "public"."compose"("composeId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "service_migration_pending_postgres_idx" ON "service_migration" USING btree ("postgresId") WHERE "service_migration"."status" IN ('pending', 'rolling_back', 'failed');--> statement-breakpoint
CREATE UNIQUE INDEX "service_migration_pending_mysql_idx" ON "service_migration" USING btree ("mysqlId") WHERE "service_migration"."status" IN ('pending', 'rolling_back', 'failed');--> statement-breakpoint
CREATE UNIQUE INDEX "service_migration_pending_mariadb_idx" ON "service_migration" USING btree ("mariadbId") WHERE "service_migration"."status" IN ('pending', 'rolling_back', 'failed');--> statement-breakpoint
CREATE UNIQUE INDEX "service_migration_pending_mongo_idx" ON "service_migration" USING btree ("mongoId") WHERE "service_migration"."status" IN ('pending', 'rolling_back', 'failed');--> statement-breakpoint
CREATE UNIQUE INDEX "service_migration_pending_redis_idx" ON "service_migration" USING btree ("redisId") WHERE "service_migration"."status" IN ('pending', 'rolling_back', 'failed');--> statement-breakpoint
CREATE UNIQUE INDEX "service_migration_pending_libsql_idx" ON "service_migration" USING btree ("libsqlId") WHERE "service_migration"."status" IN ('pending', 'rolling_back', 'failed');--> statement-breakpoint
CREATE UNIQUE INDEX "service_migration_pending_compose_idx" ON "service_migration" USING btree ("composeId") WHERE "service_migration"."status" IN ('pending', 'rolling_back', 'failed');