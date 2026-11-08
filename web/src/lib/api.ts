// Typed client for the D801 Lock Manager API.

const TOKEN_KEY = "d801.token";

export class ApiError extends Error {
  status: number;
  code: string;
  body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.message ?? body.detail ?? `Request failed (${status})`));
    this.status = status;
    this.code = String(body.error ?? "error");
    this.body = body;
  }
}

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

type Query = Record<string, string | number | boolean | undefined | null>;

function qs(params?: Query) {
  if (!params) return "";
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
}

async function request<T>(method: string, path: string, body?: unknown, params?: Query): Promise<T> {
  const headers: Record<string, string> = {};
  const token = tokenStore.get();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(path + qs(params), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, { error: "network", message: "Cannot reach the server. Check the network connection." });
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized();
    throw new ApiError(res.status, data);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, params?: Query) => request<T>("GET", path, undefined, params),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
  del: <T = void>(path: string) => request<T>("DELETE", path),
  async download(path: string, params: Query, filename: string) {
    const token = tokenStore.get();
    const res = await fetch(path + qs(params), { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => ({})));
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement("a"), { href: url, download: filename });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};

// ------------------------------------------------------------------------------------- types
export type Role = "operator" | "manager" | "admin" | "super";
export type RoomStatus = "VC" | "VD" | "OC" | "TM" | "OH" | "OT" | "TO" | "OO";

export interface Me {
  operator: { id: number; username: string; name: string; role: Role; language?: string | null } | null;
  actor: string;
  role: Role;
  role_label: string;
  permissions: string[];
}

export interface Meta {
  hotel_name: string;
  currency: string;
  default_language: string;
  checkout_time: string;
  vip_checkout_time: string;
  room_statuses: Record<RoomStatus, string>;
  card_kinds: Record<string, string>;
  card_statuses: Record<string, string>;
  id_types: string[];
  roles: Record<Role, string>;
  role_permissions: Record<Role, string[]>;
  permissions: Record<string, string>;
  calibrated: Record<string, boolean>;
  allow_uncalibrated: boolean;
  me: Me;
}

export interface Encoder {
  id: string;
  name: string;
  enabled: boolean;
  online: boolean;
  created_at: string;
  last_seen: string | null;
  host: string | null;
  port: number | null;
  dll_version: string | null;
  agent_version: string | null;
  mock: boolean | null;
}

export interface Building {
  no: number;
  name: string;
  rooms: number;
}

export interface Room {
  id: number;
  building_no: number;
  building_name: string;
  floor_no: number;
  lock_room: number;
  room_no: string;
  room_type: string;
  price: number;
  hour_start_price: number;
  hour_price: number;
  max_cards: number;
  housekeeping: "clean" | "dirty" | "maintenance";
  maintenance_note: string | null;
  public_door: boolean;
  note: string | null;
}

export interface BoardRoom extends Room {
  status: RoomStatus;
  stay: null | {
    id: number;
    kind: "walkin" | "hourly" | "team";
    guest_name: string | null;
    guest_phone: string | null;
    party_id: number | null;
    party_name: string | null;
    check_in: string;
    check_out: string;
    vip: boolean;
    cards_issued: number;
  };
  reservation: null | {
    stay_id: number;
    party_id: number;
    party_name: string;
    check_in: string;
    check_out: string;
  };
}

export interface Board {
  now: string;
  rooms: BoardRoom[];
  counts: Record<RoomStatus, number>;
  arrivals_today: number;
  departures_today: number;
}

export interface Guest {
  id?: number;
  name: string;
  sex?: "M" | "F" | null;
  id_type?: string | null;
  id_no?: string | null;
  phone?: string | null;
  is_primary?: number;
}

export interface Card {
  id: number;
  kind: string;
  kind_label: string;
  card_data: string | null;
  holder: string | null;
  room_id: number | null;
  room_no?: string | null;
  stay_id: number | null;
  building_no: number | null;
  floor_no: number | null;
  group_no: number | null;
  target_card_id: number | null;
  valid_from: string | null;
  valid_to: string | null;
  time_from: string | null;
  time_to: string | null;
  status: string;
  status_label: string;
  encoder_id: string | null;
  issued_by: string | null;
  issued_at: string;
  note: string | null;
}

export interface Party {
  id: number;
  kind: "team" | "reservation";
  leader_name: string;
  leader_id_type: string | null;
  leader_id_no: string | null;
  phone: string | null;
  note: string | null;
  created_at: string;
  created_by: string | null;
  open: boolean;
  stays: (StayBase & { room_no: string; building_no: number; room_type: string })[];
}

export interface StayBase {
  id: number;
  room_id: number;
  party_id: number | null;
  kind: "walkin" | "hourly" | "team";
  status: "reserved" | "active" | "checked_out" | "cancelled";
  check_in: string;
  check_out: string;
  checked_out_at: string | null;
  vip: boolean | number;
  price: number;
  deposit: number;
  cards_issued: number;
  note: string | null;
  created_at: string;
  created_by: string | null;
}

export interface Stay extends StayBase {
  vip: boolean;
  room: Room;
  guests: Guest[];
  party: Omit<Party, "stays" | "open"> | null;
  cards: Card[];
  overdue: boolean;
}

export interface CardInspection {
  card_data: string;
  blank: boolean;
  card_type_code: number | null;
  known: boolean;
  card: Card | null;
  stay: Stay | null;
  room: Room | null;
  erased?: boolean;
}

export interface Operator {
  id: number;
  username: string;
  name: string;
  role: Role;
  role_label: string;
  active: boolean;
  note: string | null;
  created_at: string;
  last_login: string | null;
}

export interface HotelSettings {
  hotel_name: string;
  checkout_time: string;
  vip_checkout_time: string;
  after_checkout: "dirty" | "clean";
  guest_opens_deadbolt: boolean;
  currency: string;
  default_language: string;
  co_id: number | null;
  lock_options: {
    alarm: boolean;
    remind_close: boolean;
    no_disturb: boolean;
    release_handle_lock: boolean;
    music: boolean;
    disable_cover: boolean;
  };
}

export interface AuditEntry {
  id: number;
  ts: string;
  actor: string;
  encoder_id: string | null;
  action: string;
  ok: boolean;
  ret: number | null;
  request: unknown;
  detail: string | null;
}

export interface Template {
  fn: string;
  args: [string, string | number][];
  defaults?: Record<string, string | number>;
  calibrated: boolean;
  note?: string;
}
