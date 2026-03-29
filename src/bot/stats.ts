/**
 * Stats parsing and validation for Roblox Rivals tryouts.
 *
 * Minimum requirements are set in-memory via the /stats slash command.
 * When someone posts their stats in a ticket, we parse them and compare.
 */

export interface PlayerStats {
  winRate: number    // percentage, e.g. 55.3
  level: number
  wins: number
  rank: string       // e.g. "Gold", "Diamond", etc.
}

export interface MinimumStats {
  winRate: number
  level: number
  wins: number
  rank: string
}

import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const STATS_FILE = join(process.cwd(), 'minimum-stats.json')

// Default minimums — overridden by saved file
const DEFAULT_STATS: MinimumStats = {
  winRate: 50,
  level: 30,
  wins: 1000,
  rank: 'Gold',
}

// Load from file on startup, fall back to defaults
function loadStats(): MinimumStats {
  try {
    const data = readFileSync(STATS_FILE, 'utf-8')
    const saved = JSON.parse(data)
    return { ...DEFAULT_STATS, ...saved }
  } catch {
    return { ...DEFAULT_STATS }
  }
}

function saveStats(stats: MinimumStats): void {
  writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2))
}

let minimumStats: MinimumStats = loadStats()

export function getMinimumStats(): MinimumStats {
  return { ...minimumStats }
}

export function setMinimumStats(stats: Partial<MinimumStats>): MinimumStats {
  minimumStats = { ...minimumStats, ...stats }
  saveStats(minimumStats)
  return { ...minimumStats }
}

// Rank hierarchy for Roblox Rivals ranked system
// Each tier (Bronze→Onyx) has 3 sub-tiers: III (lowest), II, I (highest)
// Nemesis and Archnemesis have no sub-tiers
const RANK_ORDER = [
  'bronze', 'silver', 'gold', 'platinum', 'diamond', 'onyx',
  'nemesis', 'archnemesis',
]

// Map sub-rank numbers to values (3 = lowest, 1 = highest)
const SUB_RANK_MAP: Record<string, number> = {
  '3': 1,
  '2': 2,
  '1': 3,
}

/**
 * Parse rank into a numeric value for comparison.
 * "Diamond 1" > "Diamond 2" > "Diamond 3" > "Platinum 1"
 * Higher value = better rank.
 */
function rankValue(rank: string): number {
  const lower = rank.toLowerCase().trim()
  // Extract base rank and optional sub-rank (roman numeral or number)
  const match = lower.match(/^(\w+)\s*(iii|ii|i|[123])?$/)
  if (!match) return -1

  const base = match[1]
  const subStr = match[2] || ''

  const tierIdx = RANK_ORDER.indexOf(base)
  if (tierIdx < 0) return -1

  // Each tier = 10 points. Sub-rank I/1 = highest (3), III/3 = lowest (1), none = 0
  const subValue = SUB_RANK_MAP[subStr] || 0
  return tierIdx * 10 + subValue
}

/**
 * Parse stats from a text message.
 * Supports formats like:
 *   Win rate: 55%
 *   LVL: 42
 *   Wins: 230
 *   Rank: Diamond
 */
export function parseStatsFromText(text: string): PlayerStats | null {
  const lines = text.toLowerCase()

  const winRateMatch = lines.match(/win\s*rate\s*[:\-]?\s*([\d.,]+)\s*%?/)
  const levelMatch = lines.match(/(?:lvl|level)\s*[:\-]?\s*([\d,]+)/)
  const winsMatch = lines.match(/wins?\s*[:\-]?\s*([\d,]+)/)
  const rankMatch = lines.match(/rank\s*[:\-]?\s*(\w+(?:\s*[123])?)/)

  if (!winRateMatch && !levelMatch && !winsMatch && !rankMatch) {
    return null // no stats found
  }

  // Strip commas from numbers (e.g. "1,523" → "1523")
  const stripCommas = (s: string) => s.replace(/,/g, '')

  return {
    winRate: winRateMatch ? parseFloat(stripCommas(winRateMatch[1])) : 0,
    level: levelMatch ? parseInt(stripCommas(levelMatch[1])) : 0,
    wins: winsMatch ? parseInt(stripCommas(winsMatch[1])) : 0,
    rank: rankMatch ? rankMatch[1].trim() : 'unknown',
  }
}

/**
 * Check if player stats meet the minimum requirements.
 */
export function meetsRequirements(player: PlayerStats): { pass: boolean; failures: string[] } {
  const failures: string[] = []
  const min = minimumStats

  if (player.winRate < min.winRate) {
    failures.push(`Win Rate: ${player.winRate}% (need ${min.winRate}%+)`)
  }
  if (player.level < min.level) {
    failures.push(`Level: ${player.level} (need ${min.level}+)`)
  }
  if (player.wins < min.wins) {
    failures.push(`Wins: ${player.wins} (need ${min.wins}+)`)
  }

  const playerRankVal = rankValue(player.rank)
  const minRankVal = rankValue(min.rank)
  if (playerRankVal >= 0 && minRankVal >= 0 && playerRankVal < minRankVal) {
    failures.push(`Rank: ${player.rank} (need ${min.rank}+)`)
  }

  return { pass: failures.length === 0, failures }
}

/**
 * Format stats for display.
 */
export function formatStats(stats: PlayerStats | MinimumStats): string {
  return [
    `Win Rate: ${stats.winRate}%`,
    `Level: ${stats.level}`,
    `Wins: ${stats.wins}`,
    `Rank: ${stats.rank}`,
  ].join('\n')
}
