// Desktop replacement for react-native-web's Alert, whose alert() is a no-op: confirm dialogs never ran
// their onPress and error alerts never showed. Mapped over react-native-web/dist/exports/Alert by
// metro.config.js. Uses the browser's blocking dialogs, which Electron shows as native message boxes.
//   no buttons / 1 button  -> window.alert, then that button's onPress
//   2+ buttons             -> window.confirm: OK = the last non-"cancel" button (the action: destructive or
//                             default), Cancel = the "cancel"-styled button (else the first one).
// ponytail: with 3+ buttons only those two are reachable (the app has no 3-button alert today); a custom
// modal is the upgrade if one appears.

export interface AlertButton {
  text?: string;
  onPress?: (value?: string) => void;
  style?: "default" | "cancel" | "destructive";
}

const text = (title: string, message?: string) => (message ? `${title}\n\n${message}` : title);

export default class Alert {
  static alert(title: string, message?: string, buttons?: AlertButton[]): void {
    const body = text(title ?? "", message);
    if (!buttons || buttons.length <= 1) {
      window.alert(body);
      buttons?.[0]?.onPress?.();
      return;
    }
    const cancel = buttons.find((b) => b.style === "cancel") ?? buttons[0];
    const ok = [...buttons].reverse().find((b) => b !== cancel)!;
    (window.confirm(body) ? ok : cancel).onPress?.();
  }
}
