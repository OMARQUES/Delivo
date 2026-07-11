CREATE TYPE "public"."store_security_status" AS ENUM('ACTIVE', 'SUSPENDED', 'CLOSED');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "token_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "security_status" "store_security_status" DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
UPDATE "stores"
SET "security_status" = CASE
  WHEN "is_active" THEN 'ACTIVE'::"store_security_status"
  ELSE 'SUSPENDED'::"store_security_status"
END;--> statement-breakpoint
ALTER TABLE "stores" DROP COLUMN "is_active";
