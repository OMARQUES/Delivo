CREATE TYPE "public"."registration_source" AS ENUM('SELF_SERVICE', 'ADMIN_PROVISIONED', 'BOOTSTRAP');--> statement-breakpoint
CREATE TYPE "public"."auth_challenge_purpose" AS ENUM('REGISTRATION_VERIFY', 'STORE_ACTIVATION', 'ADMIN_ACTIVATION', 'PASSWORD_RECOVERY');--> statement-breakpoint
CREATE TYPE "public"."auth_action_ticket_purpose" AS ENUM('PASSWORD_RESET', 'INITIAL_PASSWORD_SETUP');--> statement-breakpoint
CREATE TYPE "public"."email_outbox_status" AS ENUM('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED');--> statement-breakpoint
ALTER TYPE "public"."user_status" ADD VALUE 'PENDING_EMAIL' BEFORE 'BLOCKED';--> statement-breakpoint
ALTER TYPE "public"."user_status" ADD VALUE 'PENDING_APPROVAL' BEFORE 'BLOCKED';--> statement-breakpoint
ALTER TYPE "public"."store_security_status" ADD VALUE 'PENDING_ACTIVATION';--> statement-breakpoint
CREATE TABLE "pending_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"role" "user_role" NOT NULL,
	"password_hash" text NOT NULL,
	"terms_accepted_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"close_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_registrations_role_allowed" CHECK ("pending_registrations"."role" in ('CUSTOMER', 'DRIVER'))
);
--> statement-breakpoint
CREATE TABLE "auth_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" "auth_challenge_purpose" NOT NULL,
	"pending_registration_id" uuid,
	"user_id" uuid,
	"email" text,
	"code_hash" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_challenges_exactly_one_subject" CHECK (
      (
        case when "auth_challenges"."pending_registration_id" is null then 0 else 1 end
        + case when "auth_challenges"."user_id" is null then 0 else 1 end
        + case when "auth_challenges"."email" is null then 0 else 1 end
      ) = 1
    ),
	CONSTRAINT "auth_challenges_attempt_count_valid" CHECK ("auth_challenges"."attempt_count" between 0 and 5)
);
--> statement-breakpoint
CREATE TABLE "auth_action_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" "auth_action_ticket_purpose" NOT NULL,
	"challenge_id" uuid,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template" text NOT NULL,
	"recipient" text NOT NULL,
	"challenge_id" uuid,
	"idempotency_key" text NOT NULL,
	"dedupe_key" text,
	"status" "email_outbox_status" DEFAULT 'PENDING' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"leased_until" timestamp with time zone,
	"provider_message_id" text,
	"failure_class" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_outbox_attempt_count_valid" CHECK ("email_outbox"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "identity_security_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"result" text NOT NULL,
	"actor_user_id" uuid,
	"target_user_id" uuid,
	"subject_key" text,
	"request_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "registration_source" "registration_source" DEFAULT 'SELF_SERVICE' NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_pending_registration_id_pending_registrations_id_fk" FOREIGN KEY ("pending_registration_id") REFERENCES "public"."pending_registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_action_tickets" ADD CONSTRAINT "auth_action_tickets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_action_tickets" ADD CONSTRAINT "auth_action_tickets_challenge_id_auth_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."auth_challenges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_challenge_id_auth_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."auth_challenges"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_security_events" ADD CONSTRAINT "identity_security_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_security_events" ADD CONSTRAINT "identity_security_events_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_registrations_email_lower_idx" ON "pending_registrations" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "pending_registrations_expires_at_idx" ON "pending_registrations" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "pending_registrations_consumed_at_idx" ON "pending_registrations" USING btree ("consumed_at");--> statement-breakpoint
CREATE INDEX "auth_challenges_pending_active_idx" ON "auth_challenges" USING btree ("pending_registration_id","purpose") WHERE "auth_challenges"."pending_registration_id" is not null and "auth_challenges"."consumed_at" is null and "auth_challenges"."invalidated_at" is null;--> statement-breakpoint
CREATE INDEX "auth_challenges_user_active_idx" ON "auth_challenges" USING btree ("user_id","purpose") WHERE "auth_challenges"."user_id" is not null and "auth_challenges"."consumed_at" is null and "auth_challenges"."invalidated_at" is null;--> statement-breakpoint
CREATE INDEX "auth_challenges_email_active_idx" ON "auth_challenges" USING btree (lower("email"),"purpose") WHERE "auth_challenges"."email" is not null and "auth_challenges"."consumed_at" is null and "auth_challenges"."invalidated_at" is null;--> statement-breakpoint
CREATE INDEX "auth_challenges_expires_at_idx" ON "auth_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_action_tickets_token_hash_unique" ON "auth_action_tickets" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_action_tickets_user_idx" ON "auth_action_tickets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_action_tickets_expires_at_idx" ON "auth_action_tickets" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "email_outbox_idempotency_key_unique" ON "email_outbox" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "email_outbox_dedupe_key_unique" ON "email_outbox" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "email_outbox_status_next_attempt_idx" ON "email_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "email_outbox_leased_until_idx" ON "email_outbox" USING btree ("leased_until");--> statement-breakpoint
CREATE INDEX "email_outbox_challenge_idx" ON "email_outbox" USING btree ("challenge_id");--> statement-breakpoint
CREATE INDEX "identity_security_events_target_user_idx" ON "identity_security_events" USING btree ("target_user_id");--> statement-breakpoint
CREATE INDEX "identity_security_events_created_at_idx" ON "identity_security_events" USING btree ("created_at");
