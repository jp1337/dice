CREATE TABLE "game_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"room_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"actor_user_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_events_roomId_seq_unique" UNIQUE("room_id","seq")
);
--> statement-breakpoint
CREATE TABLE "room_members" (
	"room_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"participation" text NOT NULL,
	"is_cohost" boolean DEFAULT false NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_members_room_id_user_id_pk" PRIMARY KEY("room_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"created_by" uuid,
	"is_test" boolean NOT NULL,
	"status" text DEFAULT 'lobby' NOT NULL,
	"settings" jsonb NOT NULL,
	"watch_token" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rooms_slug_unique" UNIQUE("slug"),
	CONSTRAINT "rooms_watchToken_unique" UNIQUE("watch_token")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"discord_id" text,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"nickname" text,
	"avatar_hash" text,
	"avatar_image" "bytea",
	"avatar_content_type" text,
	"is_simulated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "users_discordId_unique" UNIQUE("discord_id")
);
--> statement-breakpoint
ALTER TABLE "game_events" ADD CONSTRAINT "game_events_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_events" ADD CONSTRAINT "game_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;