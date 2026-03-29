import 'dotenv/config'

export const config = {
  token: process.env.DISCORD_BOT_TOKEN!,
  clientId: process.env.DISCORD_CLIENT_ID!,
  guildId: process.env.DISCORD_GUILD_ID!,

  // Channels
  adminChatChannelId: process.env.ADMIN_CHAT_CHANNEL_ID!,
  requirementsChannelId: process.env.REQUIREMENTS_CHANNEL_ID!,

  // Roles
  gbftRoleId: process.env.GBFT_ROLE_ID!,
  tryoutManagerRoleId: process.env.TRYOUT_MANAGER_ROLE_ID!,
  clanMemberRoleId: process.env.CLAN_MEMBER_ROLE_ID!,
  adminRoleId: process.env.ADMIN_ROLE_ID!,
}
