// Curated list of popular apps for the "+" picker. Surfaces below the user's
// own tray so they can one-tap a familiar bookmark instead of typing a URL.
// Each entry uses the dashboard-icons slug (resolved via resolveIcon in apps.js)
// so icons stay consistent with the rest of the catalog.

export const POPULAR_APPS = [
	// Dev
	{ id: 'pop:github', name: 'GitHub', url: 'https://github.com', icon: 'github' },
	{ id: 'pop:gitlab', name: 'GitLab', url: 'https://gitlab.com', icon: 'gitlab' },
	{ id: 'pop:stackoverflow', name: 'Stack Overflow', url: 'https://stackoverflow.com', icon: 'si:stackoverflow' }, // not in Dashboard Icons
	// AI
	{ id: 'pop:claude', name: 'Claude', url: 'https://claude.ai', icon: 'claude-ai' },
	{ id: 'pop:chatgpt', name: 'ChatGPT', url: 'https://chat.openai.com', icon: 'chatgpt' },
	{ id: 'pop:perplexity', name: 'Perplexity', url: 'https://perplexity.ai', icon: 'perplexity' },
	// Productivity
	{ id: 'pop:notion', name: 'Notion', url: 'https://notion.so', icon: 'notion' },
	{ id: 'pop:linear', name: 'Linear', url: 'https://linear.app', icon: 'linear' },
	{ id: 'pop:figma', name: 'Figma', url: 'https://figma.com', icon: 'figma' },
	// Google
	{ id: 'pop:gmail', name: 'Gmail', url: 'https://mail.google.com', icon: 'gmail' },
	{ id: 'pop:gdrive', name: 'Drive', url: 'https://drive.google.com', icon: 'google-drive' },
	{ id: 'pop:gcal', name: 'Calendar', url: 'https://calendar.google.com', icon: 'google-calendar' },
	{ id: 'pop:gphotos', name: 'Photos', url: 'https://photos.google.com', icon: 'google-photos' },
	{ id: 'pop:youtube', name: 'YouTube', url: 'https://youtube.com', icon: 'youtube' },
	// Comms
	{ id: 'pop:slack', name: 'Slack', url: 'https://slack.com', icon: 'slack' },
	{ id: 'pop:discord', name: 'Discord', url: 'https://discord.com/app', icon: 'discord' },
	{ id: 'pop:whatsapp', name: 'WhatsApp', url: 'https://web.whatsapp.com', icon: 'whatsapp' },
	// Social / news
	{ id: 'pop:reddit', name: 'Reddit', url: 'https://reddit.com', icon: 'reddit' },
	{ id: 'pop:hn', name: 'Hacker News', url: 'https://news.ycombinator.com', icon: 'hacker-news' },
	{ id: 'pop:x', name: 'X', url: 'https://x.com', icon: 'x' },
	{ id: 'pop:linkedin', name: 'LinkedIn', url: 'https://linkedin.com', icon: 'linkedin' },
	// Media
	{ id: 'pop:spotify', name: 'Spotify', url: 'https://open.spotify.com', icon: 'spotify' },
	{ id: 'pop:netflix', name: 'Netflix', url: 'https://netflix.com', icon: 'netflix' },
	// Security
	{ id: 'pop:bitwarden', name: 'Bitwarden', url: 'https://vault.bitwarden.com', icon: 'bitwarden' }
];
