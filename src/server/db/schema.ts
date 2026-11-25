// Database schema (spec 6). Migrations in /drizzle are generated from this file with `npm run db:generate`.
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  customType,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { Participation, Settings } from "../../shared/contracts.js";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
const now = () => timestamp({ withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: uuid().primaryKey().defaultRandom(),
  discordId: text().unique(), // null for simulated players
  username: text().notNull(),
  displayName: text().notNull(),
  nickname: text(),
  avatarHash: text(),
  avatarImage: bytea(),
  avatarContentType: text(),
  isSimulated: boolean().notNull().default(false),
  createdAt: now(),
  lastLoginAt: timestamp({ withTimezone: true }),
});

export const sessions = pgTable("sessions", {
  id: text().primaryKey(), // hash of the session token; the token itself is never stored
  userId: uuid()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
});

export const rooms = pgTable("rooms", {
  id: uuid().primaryKey().defaultRandom(),
  slug: text().notNull().unique(),
  name: text().notNull(),
  createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
  isTest: boolean().notNull(),
  status: text({ enum: ["lobby", "running", "finished"] }).notNull().default("lobby"),
  settings: jsonb().$type<Settings>().notNull(),
  isPublic: boolean().notNull().default(true), // anyone with the room link may watch as a guest (spec 4.8)
  createdAt: now(),
  lastActivityAt: now(), // drives retention (spec 9.3)
});

export const roomMembers = pgTable(
  "room_members",
  {
    roomId: uuid()
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    participation: text({ enum: ["player", "spectator"] }).$type<Participation>().notNull(),
    isCohost: boolean().notNull().default(false),
    joinedAt: now(),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.userId] })],
);

export const gameEvents = pgTable(
  "game_events",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    roomId: uuid()
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    type: text().notNull(),
    actorUserId: uuid().references(() => users.id, { onDelete: "set null" }),
    payload: jsonb().notNull().default(sql`'{}'::jsonb`),
    createdAt: now(),
  },
  (t) => [unique().on(t.roomId, t.seq)],
);
