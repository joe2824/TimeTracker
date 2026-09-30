import { ensureNotificationPermission, notify, type NotifyOptions } from "../platform/notify";

/** Eine Systemmeldung zeigen, sofern das Betriebssystem es erlaubt - sonst still nichts. */
export async function notifyIfAllowed(opts: NotifyOptions): Promise<void> {
	if (await ensureNotificationPermission()) await notify(opts);
}
