// Shared types. The demo has no hand-built floor plan: the room comes from a phone video (see README), so ZONES stays empty.

export type Zone = { id: string; name: string; aliases: string[]; stand: [number, number]; look: [number, number] }
export const ZONES: Zone[] = []

export type Seen = { t: number; zone: string | null; objects: { label: string; box: number[] }[] }
