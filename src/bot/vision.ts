import OpenAI from 'openai'
import type { PlayerStats } from './stats'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

/**
 * Use GPT-4o vision to extract Roblox Rivals stats from a screenshot.
 * Downloads the image first and sends as base64 (Discord URLs require auth).
 */
export async function parseStatsFromImage(imageUrl: string): Promise<PlayerStats | null> {
  try {
    console.log('[Vision] Downloading image from Discord...')

    // Download image and convert to base64
    const imageResponse = await fetch(imageUrl)
    if (!imageResponse.ok) {
      console.error(`[Vision] Failed to download image: ${imageResponse.status}`)
      return null
    }

    const buffer = Buffer.from(await imageResponse.arrayBuffer())
    const contentType = imageResponse.headers.get('content-type') || 'image/png'
    const base64 = `data:${contentType};base64,${buffer.toString('base64')}`

    console.log('[Vision] Sending to GPT-4o-mini for analysis...')

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 200,
      messages: [
        {
          role: 'system',
          content: `You extract Roblox Rivals game stats from screenshots. Return ONLY a JSON object with these fields:
{"winRate": number, "level": number, "wins": number, "rank": "string"}

- winRate: the win rate/percentage (e.g. 55.3)
- level: the player level
- wins: total wins
- rank: the rank name (e.g. "Gold", "Diamond", "Silver")

If you cannot find a stat, use 0 for numbers and "unknown" for rank.
Return ONLY the JSON, no other text.`
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Extract the Roblox Rivals stats from this screenshot:' },
            { type: 'image_url', image_url: { url: base64 } },
          ],
        },
      ],
    })

    const text = response.choices[0]?.message?.content?.trim()
    console.log('[Vision] GPT response:', text)

    if (!text) return null

    // Parse JSON from response (handle markdown code blocks)
    const jsonStr = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
    const parsed = JSON.parse(jsonStr)

    return {
      winRate: Number(parsed.winRate) || 0,
      level: Number(parsed.level) || 0,
      wins: Number(parsed.wins) || 0,
      rank: String(parsed.rank || 'unknown'),
    }
  } catch (err) {
    console.error('[Vision] Failed to parse screenshot:', err)
    return null
  }
}
