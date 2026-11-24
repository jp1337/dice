// Free text other people see: nicknames, room names and the six banner (spec 4.10, 4.4 R6).
import { describe, expect, it } from "vitest";
import { createRoomRequestSchema, patchMeRequestSchema, settingsSchema } from "../src/shared/contracts.js";

const fields = {
  nickname: (text: string) => patchMeRequestSchema.safeParse({ nickname: text }),
  "room name": (text: string) => createRoomRequestSchema.safeParse({ name: text, isTest: false }),
  sixMessage: (text: string) => settingsSchema.partial().safeParse({ sixMessage: text }),
};
const value = (result: { success: boolean; data?: unknown }) => Object.values(result.data as object)[0];

describe.each(Object.entries(fields))("%s", (_name, parse) => {
  it.each([
    ["Hangul filler", "\u3164"],
    ["half-width Hangul filler", "\uFFA0"],
    ["Hangul choseong filler", "\u115F\u1160"],
    ["braille blank", "\u2800"],
    ["blank filler next to text", "Max\u3164"],
    ["line separator inside", "a\u2028b"],
    ["no-break space inside", "a\u00A0b"],
    ["ideographic space inside", "a\u3000b"],
    ["30 stacked combining marks", `a${"\u0301".repeat(30)}`],
    ["three combining marks on one letter", "x\u0301\u0302\u0303"],
    ["lone surrogate", "a\uD800"],
    ["private use", "a\uE000"],
    ["unassigned", "a\u0378"],
    ["bidi override", "\u202Eevil"],
    ["zero-width space", "a\u200Bb"],
    ["control character", "a\u0007b"],
    ["only marks", "\u0301"],
    ["only spaces", "   "],
    ["empty", ""],
  ])("refuses %s", (_case, text) => {
    expect(parse(text).success).toBe(false);
  });

  it.each([
    ["Max", "Max"],
    ["  Max  ", "Max"],
    ["Zo\u00EB", "Zo\u00EB"],
    ["Kapit\u00E4n \u{1F389}", "Kapit\u00E4n \u{1F389}"],
    ["\u2764\uFE0F Max", "\u2764\uFE0F Max"],
    ["e\u0301", "\u00E9"], // NFC
    ["!", "!"],
  ])("accepts %j", (text, expected) => {
    const result = parse(text);
    expect(result.success).toBe(true);
    expect(value(result)).toBe(expected);
  });
});
