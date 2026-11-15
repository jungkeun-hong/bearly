// The floor the demo runs on: a schematic of the two rooms in the POV walk (DI water room on the west,
// mechanical room on the east). Hand-built from the footage, not measured. x runs east, z runs south, meters.

export type Zone = { id: string; name: string; aliases: string[]; stand: [number, number]; look: [number, number] }

/** Places the wearer stops at. `stand` is where they stand, `look` is the equipment they face. */
export const ZONES: Zone[] = [
  { id: "door", name: "Entry door", aliases: ["entry door", "door", "entrance", "입구", "문"], stand: [-7.0, 3.8], look: [-8.0, 3.8] },
  { id: "di_skid", name: "DI skid", aliases: ["di skid", "skid", "스키드"], stand: [-4.6, 2.5], look: [-4.3, 0.2] },
  { id: "filters", name: "Filter housings", aliases: ["filter housings", "filters", "filter", "필터"], stand: [-6.1, 1.8], look: [-6.1, 0.2] },
  { id: "evoqua_panel", name: "Evoqua panel", aliases: ["evoqua panel", "evoqua", "di panel", "에보쿠아"], stand: [-2.7, 1.8], look: [-2.7, 0.3] },
  { id: "brine_corner", name: "Brine tank", aliases: ["brine tank", "brine", "염수"], stand: [-6.4, -2.7], look: [-7.3, -4.2] },
  { id: "softeners", name: "Softeners", aliases: ["softeners", "softener", "연수기"], stand: [-4.8, -2.7], look: [-4.8, -4.2] },
  { id: "transfer_pumps", name: "Transfer pumps", aliases: ["transfer pumps", "transfer pump", "이송 펌프"], stand: [-2.6, -2.7], look: [-2.4, -4.1] },
  { id: "storage_tank", name: "Storage tank", aliases: ["storage tank", "tank", "저장 탱크", "탱크"], stand: [-3.0, 3.7], look: [-1.6, 4.1] },
  { id: "aisle", name: "Main aisle", aliases: ["main aisle", "aisle", "통로"], stand: [2.6, 1.3], look: [5.0, 0.4] },
  { id: "chw_pumps", name: "Chilled water pumps", aliases: ["chilled water pumps", "chilled water", "red pumps", "냉수 펌프"], stand: [2.8, -1.9], look: [2.8, -3.7] },
  { id: "chemicals", name: "Chemical storage", aliases: ["chemical storage", "chemicals", "chemical", "약품"], stand: [6.2, -2.5], look: [7.1, -4.2] },
  { id: "booster_panel", name: "Booster panel", aliases: ["booster panel", "booster", "quantumflo", "quantum flow", "부스터"], stand: [6.2, 2.6], look: [7.6, 2.6] },
  { id: "gauges", name: "Gauge wall", aliases: ["gauge wall", "gauges", "gauge", "게이지"], stand: [6.2, 0.5], look: [7.6, 0.5] },
]
/** What each zone looks like through the glasses. The recognition model picks a zone from these. */
export const HINTS: Record<string, string> = {
  door: "white double doors seen close, or the corridor outside the room with ladders and carts",
  di_skid: "the DI water room seen from a few steps back: blue-frame skids with white pipes and gray vessels, cardboard boxes on the floor, wire shelving",
  filters: "seen close: a blue-frame skid with tall thin white and blue filter cartridges standing upright on a blue base, maybe an orange cone or yellow rope beside it",
  evoqua_panel: "a gray Evoqua control cabinet with touch screens, or the DI-1 / DI-2 labelled controllers and stainless box next to it",
  brine_corner: "a bare concrete wall or corner with gray PVC pipes on metal strut channels, a small blue wall controller, a black drum or brine tank",
  softeners: "white or cream fiberglass softener tanks standing in a row against a wall",
  transfer_pumps: "two dark vertical multistage pumps standing on a blue skid base, seen close",
  storage_tank: "one large white cylindrical storage tank filling most of the view",
  chw_pumps: "red or orange pump motors on concrete pads, with large silver insulated pipes and elbows above them",
  chemicals: "blue chemical jugs on the floor in a concrete corner, red tape lines on the wall",
  aisle: "an open walkway in the large mechanical room: overhead silver insulated pipes with yellow labels, tall black vertical vessels, orange cones, yellow safety vests on a rack, nothing close to the camera",
  booster_panel: "a white QuantumFlo booster control cabinet with one small blue touch screen and a red disconnect handle, seen close or from several meters away, maybe with QuantumFlo cardboard boxes or a yellow guard rail in front",
  gauges: "low on a wall of gray metal panels: an olive-green strainer or valve body at knee height, copper or steel pipes with a round pressure gauge and blue flanges, often with a hand reaching to them",
}
export const ZONE = Object.fromEntries(ZONES.map((z) => [z.id, z])) as Record<string, Zone>

type Node = { x: number; z: number; name?: string; aliases?: string[] }
export const NODES: Record<string, Node> = {
  ...Object.fromEntries(ZONES.map((z) => [z.id, { x: z.stand[0], z: z.stand[1], name: z.name, aliases: z.aliases }])),
  dock: { x: 0.9, z: -3.3, name: "Dock", aliases: ["dock", "home", "base", "charger", "도크", "충전"] },
  w1: { x: -7.3, z: 1.2 }, w2: { x: -7.3, z: -1.6 }, // west passage around the skid
  e1: { x: -1.25, z: 1.8 }, e2: { x: -1.25, z: -1.8 }, // east passage around the skid
  dw: { x: -0.6, z: 2.3 }, // doorway between the rooms
  m1: { x: 0.9, z: 2.2 }, c1: { x: 5.0, z: -0.9 },
}
export const EDGES: [string, string][] = [
  ["door", "di_skid"], ["door", "storage_tank"], ["di_skid", "filters"], ["di_skid", "evoqua_panel"], ["di_skid", "storage_tank"],
  ["filters", "w1"], ["w1", "w2"], ["w2", "brine_corner"], ["brine_corner", "softeners"], ["softeners", "transfer_pumps"],
  ["evoqua_panel", "e1"], ["e1", "e2"], ["e2", "transfer_pumps"], ["e1", "dw"], ["storage_tank", "dw"],
  ["dw", "m1"], ["m1", "aisle"], ["m1", "gauges"], ["m1", "dock"], ["aisle", "chw_pumps"], ["aisle", "booster_panel"], ["aisle", "c1"],
  ["c1", "chemicals"], ["chw_pumps", "chemicals"], ["chw_pumps", "dock"], ["gauges", "booster_panel"],
]
export const NAMED = Object.entries(NODES).filter(([, n]) => n.name) as [string, Node & { name: string }][]

export type Seen = { t: number; zone: string | null; objects: { label: string; box: number[] }[] }
