export interface NbSource {
  id: string;
  title: string;
  content: string;
  created_at?: string;
  harm_suspected?: boolean;
}

export interface PushStatus {
  ready: boolean;
  publicKey: string;
  deviceCount: number;
  subscribed: boolean;
  permissionState: NotificationPermission | 'unsupported';
  registering: boolean;
  error: string | null;
}

export function parseNbSources(raw: string | null | undefined): NbSource[] {
  if (!raw || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as NbSource[];
  } catch { /* not JSON — legacy plain text */ }
  if (/[^\w\s\uAC00-\uD7A3\u3131-\u318E\u1100-\u11FF().,·\-+%$\n:#\[\]@!?/"'=]/.test(raw)) return [];
  return [{ id: crypto.randomUUID(), title: '기존 소스', content: raw }];
}
