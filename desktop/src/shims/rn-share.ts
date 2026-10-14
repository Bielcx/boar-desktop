// Desktop replacement for react-native-web's Share: Electron has no navigator.share, so Share.share
// rejected and the code-block copy button (MarkdownMessage.tsx) did nothing. On desktop "share text"
// means "copy it": the message (or url) goes to the clipboard. Mapped by metro.config.js.

export default class Share {
  static async share(content: { message?: string; url?: string; title?: string }): Promise<{ action: string }> {
    await navigator.clipboard.writeText(content.message ?? content.url ?? "");
    return { action: Share.sharedAction };
  }
  static get sharedAction() {
    return "sharedAction";
  }
  static get dismissedAction() {
    return "dismissedAction";
  }
}
