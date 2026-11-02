import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  Routes,
  REST,
  ActivityType,
  MessageFlags,
} from 'discord.js';
import {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
} from '@discordjs/voice';
import { startWhisperServer, stopWhisperServer } from './stt/whisper.js';
import { setupVoiceReceiver } from './voice/receiver.js';
import { MusicPlayer } from './player/musicPlayer.js';

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!TOKEN) {
  console.error('[Config] DISCORD_TOKEN is missing in .env! Please create a bot and set token.');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// Guild state: guildId -> { connection, player, receiverCleanup, autoLeaveTimer }
const guildStates = new Map();

// Register Slash Commands
const commands = [
  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Приєднатися до голосового каналу та слухати співи')
    .addChannelOption((opt) =>
      opt.setName('channel').setDescription('Голосовий канал (за замовчуванням ваш поточний)')
    ),
  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Покинути голосовий канал'),
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Відтворити пісню за назвою або посиланням')
    .addStringOption((opt) =>
      opt.setName('query').setDescription('Назва треку або YouTube посилання').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Пропустити поточну пісню'),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Зупинити відтворення музики'),
  new SlashCommandBuilder()
    .setName('back')
    .setDescription('Увімкнути попередню пісню з історії'),
].map((cmd) => cmd.toJSON());

async function registerCommands() {
  if (!TOKEN || !CLIENT_ID) return;
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    console.log('[Discord] Registering slash commands...');
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log(`[Discord] Registered commands for guild: ${GUILD_ID}`);
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('[Discord] Registered global commands.');
    }
  } catch (err) {
    console.error('[Discord] Failed to register slash commands:', err);
  }
}

client.once('ready', async () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);
  client.user.setActivity('GitHub', { type: ActivityType.Watching });
  await registerCommands();
});

// Auto-leave when channel is empty of humans
client.on('voiceStateUpdate', (oldState, newState) => {
  const guild = oldState.guild || newState.guild;
  const state = guildStates.get(guild.id);
  if (!state || !state.connection) return;

  const connection = state.connection;
  const channelId = connection.joinConfig.channelId;
  const channel = guild.channels.cache.get(channelId);
  if (!channel) return;

  // Count non-bot members
  const humans = channel.members.filter((m) => !m.user.bot).size;

  if (humans === 0) {
    if (!state.autoLeaveTimer) {
      console.log(`[Voice] Channel empty. Starting 60s auto-leave countdown for guild ${guild.id}`);
      state.autoLeaveTimer = setTimeout(() => {
        console.log(`[Voice] 60s expired with no humans. Leaving guild ${guild.id}`);
        leaveVoice(guild.id);
      }, 60000);
    }
  } else if (state.autoLeaveTimer) {
    clearTimeout(state.autoLeaveTimer);
    state.autoLeaveTimer = null;
  }
});

async function leaveVoice(guildId) {
  const state = guildStates.get(guildId);
  if (state) {
    if (state.autoLeaveTimer) clearTimeout(state.autoLeaveTimer);
    if (state.player) state.player.stop();
    if (state.receiverCleanup) state.receiverCleanup();
    if (state.connection) {
      try {
        state.connection.destroy();
      } catch {}
    }
    guildStates.delete(guildId);
  }

  // If no other guilds connected, stop whisper-server
  if (guildStates.size === 0) {
    stopWhisperServer();
  }
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guildId, member, channel } = interaction;
  if (!guildId) {
    await interaction.reply({ content: 'Команди працюють тільки на серверах.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (commandName === 'join') {
    const targetChannel = interaction.options.getChannel('channel') || member?.voice?.channel;
    if (!targetChannel) {
      await interaction.reply({
        content: 'Ви повинні бути в голосовому каналі або вказати канал у параметрах.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply();

    try {
      // 1. Start whisper-server if not already running
      await startWhisperServer();

      // 2. Connect to voice channel (selfDeaf: false is required to receive audio)
      const connection = joinVoiceChannel({
        channelId: targetChannel.id,
        guildId: targetChannel.guild.id,
        adapterCreator: targetChannel.guild.voiceAdapterCreator,
        selfDeaf: false,
      });

      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5000),
          ]);
        } catch {
          leaveVoice(guildId);
        }
      });

      const player = new MusicPlayer(channel);
      connection.subscribe(player.player);

      const receiver = setupVoiceReceiver(connection, player, client.user.id);

      guildStates.set(guildId, {
        connection,
        player,
        receiverCleanup: receiver.cleanup,
        autoLeaveTimer: null,
      });

      await interaction.editReply(`✅ Приєднався до **${targetChannel.name}**! Співайте пісню або кажіть команди.`);
    } catch (err) {
      console.error('[Command:join] Error:', err);
      await interaction.editReply(`❌ Не вдалося приєднатися: ${err.message}`);
    }
    return;
  }

  const state = guildStates.get(guildId);

  if (commandName === 'leave') {
    if (!state) {
      await interaction.reply({ content: 'Бот зараз не в голосовому каналі.', flags: MessageFlags.Ephemeral });
      return;
    }
    await leaveVoice(guildId);
    await interaction.reply('👋 Покинув голосовий канал.');
    return;
  }

  if (commandName === 'play') {
    const query = interaction.options.getString('query');
    if (!state) {
      await interaction.reply({
        content: 'Спочатку викличте `/join`, щоб бот приєднався до каналу.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply();
    await state.player.play(query);
    await interaction.editReply(`🔍 Шукаю та відтворюю: **${query}**`);
    return;
  }

  if (commandName === 'skip') {
    if (!state || !state.player.currentTrack) {
      await interaction.reply({ content: 'Зараз нічого не грає.', flags: MessageFlags.Ephemeral });
      return;
    }
    state.player.skip();
    await interaction.reply('⏭️ Пропущено.');
    return;
  }

  if (commandName === 'stop') {
    if (!state) {
      await interaction.reply({ content: 'Зараз нічого не грає.', flags: MessageFlags.Ephemeral });
      return;
    }
    state.player.stop();
    await interaction.reply('⏹️ Зупинено.');
    return;
  }

  if (commandName === 'back') {
    if (!state) {
      await interaction.reply({ content: 'Бот не в каналі.', flags: MessageFlags.Ephemeral });
      return;
    }
    const ok = state.player.back();
    await interaction.reply(ok ? '⏮️ Вмикаю попередню пісню...' : 'ℹ️ Немає треків у пам’яті.');
    return;
  }
});

// Process cleanup
process.on('SIGINT', () => {
  stopWhisperServer();
  process.exit(0);
});
process.on('SIGTERM', () => {
  stopWhisperServer();
  process.exit(0);
});

if (TOKEN) {
  client.login(TOKEN);
} else {
  console.log('[Notice] DISCORD_TOKEN is not configured yet. Add it to .env and run `npm start`.');
}
