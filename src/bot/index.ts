import {
  Client, GatewayIntentBits, Events, ChannelType,
  SlashCommandBuilder, REST, Routes,
  EmbedBuilder, TextChannel,
  type ChatInputCommandInteraction,
  type Message,
} from 'discord.js'
import { config } from './config'
import {
  parseStatsFromText, meetsRequirements, formatStats,
  getMinimumStats, setMinimumStats,
} from './stats'
import { parseStatsFromImage } from './vision'

const LOG = '[VanioRoblox]'

// Track which ticket channels are awaiting stats
const awaitingStats = new Set<string>() // channel IDs
const greetedChannels = new Set<string>() // channels we already sent the welcome to
const ticketOwners = new Map<string, string>() // channel ID → user ID who opened the ticket

// ─── Bot Client ───────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
})

// ─── Slash Commands ───────────────────────────────────────────────────────────

const statsCommand = new SlashCommandBuilder()
  .setName('stats')
  .setDescription('View or set minimum stat requirements for tryouts')
  .addNumberOption(opt => opt.setName('winrate').setDescription('Minimum win rate %'))
  .addIntegerOption(opt => opt.setName('level').setDescription('Minimum level'))
  .addIntegerOption(opt => opt.setName('wins').setDescription('Minimum wins'))
  .addStringOption(opt => opt.setName('rank').setDescription('Minimum rank (e.g. Gold, Diamond)'))

const redoCommand = new SlashCommandBuilder()
  .setName('redo')
  .setDescription('Restart the stats check in this ticket channel')

const passedCommand = new SlashCommandBuilder()
  .setName('passed')
  .setDescription('Mark the tryout as passed — gives the ticket opener the Clan Member role')

const testCommand = new SlashCommandBuilder()
  .setName('test')
  .setDescription('Test stats check without notifying admins or assigning roles')
  .addStringOption(opt => opt.setName('winrate').setDescription('Win rate %').setRequired(true))
  .addStringOption(opt => opt.setName('level').setDescription('Level').setRequired(true))
  .addStringOption(opt => opt.setName('wins').setDescription('Wins').setRequired(true))
  .addStringOption(opt => opt.setName('rank').setDescription('Rank (e.g. Gold 2)').setRequired(true))

// Track test mode channels — no admin notifications, no role changes
const testModeChannels = new Set<string>()

async function registerCommands() {
  const rest = new REST().setToken(config.token)
  console.log(`${LOG} Registering slash commands...`)
  await rest.put(
    Routes.applicationGuildCommands(config.clientId, config.guildId),
    { body: [statsCommand.toJSON(), redoCommand.toJSON(), passedCommand.toJSON(), testCommand.toJSON()] },
  )
  console.log(`${LOG} Slash commands registered`)
}

// ─── Event: Ready ─────────────────────────────────────────────────────────────

client.once(Events.ClientReady, async (c) => {
  console.log(`${LOG} Bot online as ${c.user.tag}`)
  await registerCommands()
})

// ─── Event: Slash Command ─────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return

  // ── /redo command ──
  if (interaction.commandName === 'redo') {
    const channelId = interaction.channelId
    awaitingStats.add(channelId)
    await interaction.reply('Stats check restarted! Please send your stats again.\n\n**Format:**\n> Win rate:\n> LVL:\n> Wins:\n> Rank:\n\nOr send a screenshot of your stats tab.')
    return
  }

  // ── /test command — run stats check silently ──
  if (interaction.commandName === 'test') {
    const cmd = interaction as ChatInputCommandInteraction
    const testStats = {
      winRate: parseFloat(cmd.options.getString('winrate')!.replace(/[,%]/g, '')),
      level: parseInt(cmd.options.getString('level')!.replace(/,/g, '')),
      wins: parseInt(cmd.options.getString('wins')!.replace(/,/g, '')),
      rank: cmd.options.getString('rank')!.trim(),
    }

    const result = meetsRequirements(testStats)
    const min = getMinimumStats()

    const embed = new EmbedBuilder()
      .setTitle('Test Result (no notifications sent)')
      .setDescription(
        `**Stats tested:**\n${formatStats(testStats)}\n\n` +
        `**Minimum required:**\n${formatStats(min)}\n\n` +
        (result.pass
          ? '**Result: PASS** — would notify tryout managers'
          : `**Result: FAIL** — would assign GBFT role\n\n**Issues:**\n${result.failures.map(f => `- ${f}`).join('\n')}`)
      )
      .setColor(result.pass ? 0x57f287 : 0xed4245)

    await cmd.reply({ embeds: [embed], ephemeral: true })
    return
  }

  // ── /passed command ──
  if (interaction.commandName === 'passed') {
    const channelId = interaction.channelId
    const ticketOwnerId = ticketOwners.get(channelId)

    if (!ticketOwnerId) {
      await interaction.reply({ content: 'Could not find the ticket owner for this channel. Make sure this is a ticket channel where someone submitted stats.', ephemeral: true })
      return
    }

    try {
      const member = await interaction.guild?.members.fetch(ticketOwnerId)
      if (member) {
        await member.roles.add(config.clanMemberRoleId)

        const embed = new EmbedBuilder()
          .setTitle('Tryout Passed!')
          .setDescription(
            `Congratulations <@${ticketOwnerId}>! You have **passed** your tryout!\n\n` +
            `You have been given the **Clan Member** role. Welcome to the team!`
          )
          .setColor(0x57f287)

        await interaction.reply({ embeds: [embed] })
        console.log(`${LOG} Assigned Clan Member role to user ${ticketOwnerId} — passed by ${interaction.user.tag}`)
      } else {
        await interaction.reply({ content: 'Could not find that user in the server.', ephemeral: true })
      }
    } catch (err) {
      console.error(`${LOG} Failed to assign Clan Member role:`, err)
      await interaction.reply({ content: 'Failed to assign the role. Make sure the bot role is above the Clan Member role in the server settings.', ephemeral: true })
    }
    return
  }

  if (interaction.commandName !== 'stats') return

  // Only admins can use /stats
  const member = await interaction.guild?.members.fetch(interaction.user.id)
  if (!member?.roles.cache.has(config.adminRoleId)) {
    await interaction.reply({ content: 'Only admins can use this command.', ephemeral: true })
    return
  }

  const cmd = interaction as ChatInputCommandInteraction
  const winrate = cmd.options.getNumber('winrate')
  const level = cmd.options.getInteger('level')
  const wins = cmd.options.getInteger('wins')
  const rank = cmd.options.getString('rank')

  // If no options provided, show current minimums
  if (winrate == null && level == null && wins == null && rank == null) {
    const current = getMinimumStats()
    const embed = new EmbedBuilder()
      .setTitle('Current Minimum Requirements')
      .setDescription(formatStats(current))
      .setColor(0x5865f2)
    await cmd.reply({ embeds: [embed] })
    return
  }

  // Update minimums
  const updates: Record<string, any> = {}
  if (winrate != null) updates.winRate = winrate
  if (level != null) updates.level = level
  if (wins != null) updates.wins = wins
  if (rank != null) updates.rank = rank

  const updated = setMinimumStats(updates)
  const embed = new EmbedBuilder()
    .setTitle('Minimum Requirements Updated')
    .setDescription(formatStats(updated))
    .setColor(0x57f287)
  await cmd.reply({ embeds: [embed] })
})

// ─── Event: Channel Create (Ticket Detection) ────────────────────────────────

async function handleTicketChannel(channel: TextChannel) {
  if (greetedChannels.has(channel.id)) return // already greeted

  const name = channel.name.toLowerCase()
  const isTicket = name.includes('ticket') || name.includes('tryout')
  if (!isTicket) return

  console.log(`${LOG} Ticket channel detected: #${channel.name}`)

  // Mark as awaiting stats
  greetedChannels.add(channel.id)
  awaitingStats.add(channel.id)

  // Small delay to let the ticket tool finish setup
  await new Promise(r => setTimeout(r, 2000))

  // Get the channel's topic or first message to find the ticket creator
  // Most ticket bots mention the user in the first message or topic
  let ticketCreatorMention = ''
  try {
    const messages = await channel.messages.fetch({ limit: 5 })
    const botMessages = messages.filter(m => m.author.bot)
    // Look for a user mention in bot messages
    for (const [, msg] of botMessages) {
      if (msg.mentions.users.size > 0) {
        const user = msg.mentions.users.first()!
        ticketCreatorMention = `<@${user.id}>`
        break
      }
    }
    // Fallback: check channel topic
    if (!ticketCreatorMention && channel.topic) {
      const userIdMatch = channel.topic.match(/(\d{17,20})/)
      if (userIdMatch) ticketCreatorMention = `<@${userIdMatch[1]}>`
    }
    // Fallback: first non-bot user who sent a message
    if (!ticketCreatorMention) {
      const userMsg = messages.filter(m => !m.author.bot).first()
      if (userMsg) ticketCreatorMention = `<@${userMsg.author.id}>`
    }
  } catch (err) {
    console.warn(`${LOG} Could not determine ticket creator:`, err)
  }

  // Send welcome message
  const welcomeMessage = `Welcome, ${ticketCreatorMention || 'there'}! Please send your stats in Rivals in one of these formats:

**Format #1:** Just a screenshot of your stats tab (normal stats, not ranked)

**Format #2:**
> Win rate:
> LVL:
> Wins:
> Rank:

Once you have sent your stats, one of our staff members will get your tryout started.

**Please DO NOT ping ANY staff members.** Thank you.`

  await channel.send(welcomeMessage)
}

// Trigger 1: Bot sees the channel being created
client.on(Events.ChannelCreate, async (channel) => {
  if (channel.type !== ChannelType.GuildText) return
  await handleTicketChannel(channel)
})

// Trigger 2: Another bot's message in a ticket channel we haven't greeted yet
// This catches private ticket channels where we missed the create event
client.on(Events.MessageCreate, async (message: Message) => {
  if (message.author.bot && message.author.id !== client.user?.id && !greetedChannels.has(message.channel.id)) {
    const ch = message.channel
    if (ch.type === ChannelType.GuildText) {
      await handleTicketChannel(ch)
    }
  }
})

// ─── Event: Message (Stats Detection) ─────────────────────────────────────────

client.on(Events.MessageCreate, async (message: Message) => {
  // Ignore bots
  if (message.author.bot) return

  // Track first non-bot user in ticket channels as the ticket owner
  if (!ticketOwners.has(message.channel.id) && greetedChannels.has(message.channel.id)) {
    ticketOwners.set(message.channel.id, message.author.id)
  }

  // Only process in ticket channels awaiting stats
  if (!awaitingStats.has(message.channel.id)) return

  // Check for text stats
  const stats = parseStatsFromText(message.content)

  // Check for screenshot (image attachment)
  const hasImage = message.attachments.some(a =>
    a.contentType?.startsWith('image/') ?? false
  )

  if (!stats && !hasImage) return // Not a stats submission

  let finalStats = stats

  // If screenshot, use AI vision to extract stats
  if (hasImage && !finalStats) {
    const image = message.attachments.find(a => a.contentType?.startsWith('image/'))
    if (!image) return

    await message.reply('Scanning your stats screenshot...')

    if (!process.env.OPENAI_API_KEY) {
      // No API key — fall back to manual review
      awaitingStats.delete(message.channel.id)
      const adminChannel = client.channels.cache.get(config.adminChatChannelId) as TextChannel | undefined
      if (adminChannel) {
        await adminChannel.send(
          `<@&${config.tryoutManagerRoleId}> A screenshot was submitted in <#${message.channel.id}> by <@${message.author.id}>. Please review their stats manually.`
        )
      }
      return
    }

    finalStats = await parseStatsFromImage(image.url)
    if (!finalStats) {
      await message.reply('Could not read your stats from the screenshot. Please try sending them in text format:\n> Win rate:\n> LVL:\n> Wins:\n> Rank:')
      return // Don't remove from awaiting — let them try again
    }
  }

  if (!finalStats) return

  // We have parsed stats — check against requirements
  awaitingStats.delete(message.channel.id)

  const result = meetsRequirements(finalStats)

  if (!result.pass) {
    // Does NOT meet requirements
    const failEmbed = new EmbedBuilder()
      .setTitle('Stats Check Result')
      .setDescription(
        `<@${message.author.id}> We are sorry to inform you that you **DO NOT** meet the minimum requirements.\n\n` +
        `**Your stats:**\n${formatStats(finalStats)}\n\n` +
        `**Issues:**\n${result.failures.map(f => `- ${f}`).join('\n')}\n\n` +
        `You will be given the **GBFT** role which will notify our moderators/admins that you are working on your stats.\n\n` +
        `Thank you and again sorry. Please create another ticket once you reach the minimum requirements.\n` +
        `See the requirements here: <#${config.requirementsChannelId}>`
      )
      .setColor(0xed4245)

    await message.reply({ embeds: [failEmbed] })

    // Send DM so they can see it after ticket is closed
    try {
      const dmEmbed = new EmbedBuilder()
        .setTitle('Tryout Result')
        .setDescription(
          `We are sorry to inform you that you **DO NOT** meet the minimum requirements.\n\n` +
          `**Your stats:**\n${formatStats(finalStats)}\n\n` +
          `**Issues:**\n${result.failures.map(f => `- ${f}`).join('\n')}\n\n` +
          `You have been given the **GBFT** role. Please create another ticket once you reach the minimum requirements.`
        )
        .setColor(0xed4245)
      await message.author.send({ embeds: [dmEmbed] })
    } catch (dmErr) {
      console.warn(`${LOG} Could not DM user ${message.author.tag} (DMs may be disabled)`)
    }

    // Assign GBFT role
    try {
      const member = await message.guild?.members.fetch(message.author.id)
      if (member) {
        await member.roles.add(config.gbftRoleId)
        console.log(`${LOG} Assigned GBFT role to ${message.author.tag}`)
      }
    } catch (err) {
      console.warn(`${LOG} Failed to assign GBFT role:`, err)
    }

    // Auto-delete ticket channel after 300 seconds (5 minutes)
    await message.channel.send('This ticket will be automatically deleted in **5 minutes**.')
    setTimeout(async () => {
      try {
        await message.channel.delete()
        console.log(`${LOG} Auto-deleted ticket channel after failed tryout`)
      } catch (err) {
        console.warn(`${LOG} Failed to auto-delete ticket channel:`, err)
      }
    }, 300_000)
  } else {
    // MEETS requirements — notify tryout managers
    const passEmbed = new EmbedBuilder()
      .setTitle('Stats Check Result')
      .setDescription(
        `<@${message.author.id}> Congratulations! You **meet** the minimum requirements!\n\n` +
        `**Your stats:**\n${formatStats(finalStats)}\n\n` +
        `A tryout manager has been notified and will be with you shortly. Please wait here.`
      )
      .setColor(0x57f287)

    await message.reply({ embeds: [passEmbed] })

    // Notify admin-chatchat channel
    const adminChannel = client.channels.cache.get(config.adminChatChannelId) as TextChannel | undefined
    if (adminChannel) {
      await adminChannel.send(
        `<@&${config.tryoutManagerRoleId}> New tryout ready! <@${message.author.id}> meets the requirements in <#${message.channel.id}>.\n\n**Stats:**\n${formatStats(finalStats)}`
      )
    }
  }
})

// ─── Start ────────────────────────────────────────────────────────────────────

client.login(config.token).catch(err => {
  console.error(`${LOG} Failed to login:`, err)
  process.exit(1)
})
