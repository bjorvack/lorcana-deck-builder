// Local stub for @discord/embedded-app-sdk. Upstream's shared package imports
// DiscordSDK for Discord rich presence, which is unused in headless training.
// Shipping a stub avoids pulling the real SDK (browser/Discord-only) into the
// install graph. See scripts/training/vendor/PIN.md.
export class DiscordSDK {
  ready: Promise<unknown> = Promise.resolve();
  commands: unknown;
  [key: string]: unknown;
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(..._args: unknown[]) {}
}
export type CommandInput<T = unknown> = T;
