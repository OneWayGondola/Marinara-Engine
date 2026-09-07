// ──────────────────────────────────────────────
// Game: Dice Rolling Service
// ──────────────────────────────────────────────

import type { DiceRollResult } from "@marinara-engine/shared";

export const DICE_NOTATION_REGEX = /^(\d+)?d(\d+)([+-]\d+)?$/i;

export function isDiceNotation(value: string): boolean {
  const match = value.trim().match(DICE_NOTATION_REGEX);
  if (!match) return false;
  const count = parseInt(match[1] ?? "1", 10);
  const sides = parseInt(match[2]!, 10);
  return count >= 1 && sides >= 1;
}

/**
 * Parse and roll dice using NdM notation (e.g. "2d6+3", "d20", "4d8-1").
 * Returns individual rolls, modifier, and total.
 */
export function rollDice(notation: string): DiceRollResult {
  const match = notation.trim().match(DICE_NOTATION_REGEX);
  if (!match) {
    throw new Error(`Invalid dice notation: "${notation}". Use NdM format (e.g. 2d6, d20+3, 4d8-1).`);
  }

  const count = Math.min(parseInt(match[1] ?? "1", 10), 100);
  const sides = Math.min(parseInt(match[2]!, 10), 1000);
  const modifier = match[3] ? parseInt(match[3], 10) : 0;

  if (count < 1 || sides < 1) {
    throw new Error("Dice count and sides must be at least 1.");
  }

  const rolls: number[] = [];
  for (let i = 0; i < count; i++) {
    rolls.push(Math.floor(Math.random() * sides) + 1);
  }

  const total = rolls.reduce((sum, r) => sum + r, 0) + modifier;

  return { notation: notation.trim(), rolls, modifier, total };
}

/**
 * Read a successful `roll_dice` tool result back as the message-extra shape `/roll`
 * writes, so a tool-called roll renders through the same animated dice card.
 * Returns null for refusals, malformed payloads, or anything the card cannot draw.
 */
export function parseRollDiceToolResult(raw: string): DiceRollResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const payload = parsed as Record<string, unknown>;
  const notation = typeof payload.notation === "string" ? payload.notation.trim() : "";
  const rolls = Array.isArray(payload.rolls) ? payload.rolls : null;
  const modifier = typeof payload.modifier === "number" ? payload.modifier : 0;
  const total = payload.total;

  if (!notation || !rolls || rolls.length === 0) return null;
  if (!rolls.every((roll): roll is number => typeof roll === "number" && Number.isFinite(roll))) return null;
  if (typeof total !== "number" || !Number.isFinite(total)) return null;
  if (!Number.isFinite(modifier)) return null;

  return { notation, rolls, modifier, total };
}
