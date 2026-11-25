-- Rooms from before the switch keep who could watch them: public only where the guest link was on.
UPDATE "rooms" SET "is_public" = "watch_token" IS NOT NULL;--> statement-breakpoint
-- The history entry of the switch replaces the one of the guest link.
UPDATE "game_events" SET "type" = 'public_changed', "payload" = jsonb_build_object('isPublic', "payload" -> 'enabled') WHERE "type" = 'watch_link_changed';
