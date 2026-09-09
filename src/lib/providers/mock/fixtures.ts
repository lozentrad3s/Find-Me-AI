/**
 * Mock place data for Jos and Abuja.
 *
 * This is synthetic, but it is *geometrically coherent*: where a fixture says
 * a guest house is behind a mosque, the two points really are ~50 m apart on
 * the correct bearing. That matters, because the anchor-proximity signal is
 * doing real trigonometry — feeding it incoherent data would make the harness
 * score the scorer rather than the addresses.
 *
 * The ambiguity is deliberate. Three separate Buhari Streets in Jos and two
 * in Abuja exist so the moderate band and the disambiguation question are
 * exercised on every run, not just in theory.
 *
 * Replace with the Google provider by setting PLACES_PROVIDER=google.
 */

import type { LatLng } from "@/lib/geo/distance";

export type FixtureCity = "jos" | "abuja";

export interface FixturePlace {
  placeId: string;
  name: string;
  formattedAddress: string;
  point: LatLng;
  types: string[];
  /** 0..1 — how well-known. Stands in for review-count-derived importance. */
  prominence: number;
  city: FixtureCity;
  area: string;
}

export const CITY_CENTRES: Record<FixtureCity, LatLng> = {
  jos: { lat: 9.8965, lng: 8.8583 },
  abuja: { lat: 9.0765, lng: 7.3986 },
};

/** Area names per city — used as parser hints and for the area-match signal. */
export const KNOWN_AREAS: Record<FixtureCity, string[]> = {
  jos: [
    "Rayfield", "Terminus", "Farin Gada", "Naraguta", "Bukuru", "Angwan Rukuba",
    "Tudun Wada", "Jenta", "Katako", "Laranto", "Dogon Dutse", "Gada Biu",
    "Zaria Road", "Old Airport Road", "Lamingo",
  ],
  abuja: [
    "Wuse", "Wuse 2", "Garki", "Maitama", "Asokoro", "Gwarinpa", "Utako",
    "Jabi", "Kubwa", "Nyanya", "Lugbe", "Central Business District", "Wuye",
  ],
};

// ---------------------------------------------------------------------------
// Jos
// ---------------------------------------------------------------------------

const JOS: FixturePlace[] = [
  // --- Rayfield cluster -----------------------------------------------------
  {
    placeId: "jos-rayfield-resort",
    name: "Rayfield Resort",
    formattedAddress: "Rayfield Road, Rayfield, Jos, Plateau",
    point: { lat: 9.8471, lng: 8.8748 },
    types: ["tourist_attraction", "resort"],
    prominence: 0.75,
    city: "jos",
    area: "Rayfield",
  },
  {
    placeId: "jos-rayfield-mosque",
    name: "Rayfield Central Mosque",
    formattedAddress: "Buhari Street, Rayfield, Jos, Plateau",
    point: { lat: 9.8489, lng: 8.8761 },
    types: ["mosque", "place_of_worship"],
    prominence: 0.4,
    city: "jos",
    area: "Rayfield",
  },
  {
    // ~55 m north-east of the mosque: "behind the mosque" resolves here.
    placeId: "jos-bluewiz-lodge",
    name: "Bluewiz Lodge",
    formattedAddress: "Off Buhari Street, Rayfield, Jos, Plateau",
    point: { lat: 9.8493, lng: 8.8766 },
    types: ["lodging", "guest_house"],
    prominence: 0.2,
    city: "jos",
    area: "Rayfield",
  },
  {
    placeId: "jos-buhari-st-rayfield",
    name: "Buhari Street",
    formattedAddress: "Buhari Street, Rayfield, Jos, Plateau",
    point: { lat: 9.8483, lng: 8.8752 },
    types: ["route"],
    prominence: 0.15,
    city: "jos",
    area: "Rayfield",
  },
  {
    placeId: "jos-zenith-rayfield",
    name: "Zenith Bank Rayfield",
    formattedAddress: "Rayfield Road, Rayfield, Jos, Plateau",
    point: { lat: 9.8465, lng: 8.877 },
    types: ["bank", "finance"],
    prominence: 0.5,
    city: "jos",
    area: "Rayfield",
  },
  {
    // ~45 m from Zenith: "the place beside the bank".
    placeId: "jos-crunchies-rayfield",
    name: "Crunchies Fried Chicken",
    formattedAddress: "Rayfield Road, Rayfield, Jos, Plateau",
    point: { lat: 9.8462, lng: 8.8774 },
    types: ["restaurant", "food"],
    prominence: 0.55,
    city: "jos",
    area: "Rayfield",
  },

  // --- Terminus cluster -----------------------------------------------------
  {
    placeId: "jos-main-market",
    name: "Jos Main Market",
    formattedAddress: "Ahmadu Bello Way, Terminus, Jos, Plateau",
    point: { lat: 9.9285, lng: 8.8921 },
    types: ["market", "shopping"],
    prominence: 0.9,
    city: "jos",
    area: "Terminus",
  },
  {
    placeId: "jos-terminus-junction",
    name: "Terminus Junction",
    formattedAddress: "Ahmadu Bello Way, Terminus, Jos, Plateau",
    point: { lat: 9.9279, lng: 8.893 },
    types: ["intersection", "route"],
    prominence: 0.5,
    city: "jos",
    area: "Terminus",
  },
  {
    // Duplicate street name #2.
    placeId: "jos-buhari-st-terminus",
    name: "Buhari Street",
    formattedAddress: "Buhari Street, Terminus, Jos, Plateau",
    point: { lat: 9.9292, lng: 8.8912 },
    types: ["route"],
    prominence: 0.2,
    city: "jos",
    area: "Terminus",
  },
  {
    placeId: "jos-leventis",
    name: "Leventis Roundabout",
    formattedAddress: "Murtala Mohammed Way, Terminus, Jos, Plateau",
    point: { lat: 9.927, lng: 8.894 },
    types: ["intersection", "route"],
    prominence: 0.6,
    city: "jos",
    area: "Terminus",
  },
  {
    placeId: "jos-firstbank-terminus",
    name: "First Bank Terminus",
    formattedAddress: "Ahmadu Bello Way, Terminus, Jos, Plateau",
    point: { lat: 9.9288, lng: 8.8935 },
    types: ["bank", "finance"],
    prominence: 0.55,
    city: "jos",
    area: "Terminus",
  },

  // --- Farin Gada cluster ---------------------------------------------------
  {
    placeId: "jos-farin-gada-market",
    name: "Farin Gada Market",
    formattedAddress: "Zaria Road, Farin Gada, Jos, Plateau",
    point: { lat: 9.9518, lng: 8.8788 },
    types: ["market", "shopping"],
    prominence: 0.7,
    city: "jos",
    area: "Farin Gada",
  },
  {
    // Duplicate street name #3.
    placeId: "jos-buhari-st-faringada",
    name: "Buhari Street",
    formattedAddress: "Buhari Street, Farin Gada, Jos, Plateau",
    point: { lat: 9.9526, lng: 8.8783 },
    types: ["route"],
    prominence: 0.18,
    city: "jos",
    area: "Farin Gada",
  },
  {
    placeId: "jos-total-faringada",
    name: "Total Filling Station Farin Gada",
    formattedAddress: "Zaria Road, Farin Gada, Jos, Plateau",
    point: { lat: 9.9512, lng: 8.8801 },
    types: ["gas_station", "fuel"],
    prominence: 0.5,
    city: "jos",
    area: "Farin Gada",
  },
  {
    // ~70 m from the filling station: "opposite the filling station".
    placeId: "jos-green-palace",
    name: "Green Palace Hotel",
    formattedAddress: "Zaria Road, Farin Gada, Jos, Plateau",
    point: { lat: 9.9508, lng: 8.8806 },
    types: ["lodging", "hotel"],
    prominence: 0.35,
    city: "jos",
    area: "Farin Gada",
  },

  // --- Naraguta / university ------------------------------------------------
  {
    placeId: "jos-unijos-naraguta",
    name: "University of Jos, Naraguta Campus",
    formattedAddress: "Bauchi Road, Naraguta, Jos, Plateau",
    point: { lat: 9.9603, lng: 8.8897 },
    types: ["university", "school"],
    prominence: 0.85,
    city: "jos",
    area: "Naraguta",
  },
  {
    placeId: "jos-naraguta-guest-house",
    name: "Naraguta Guest House",
    formattedAddress: "Bauchi Road, Naraguta, Jos, Plateau",
    point: { lat: 9.9612, lng: 8.8905 },
    types: ["lodging", "guest_house"],
    prominence: 0.3,
    city: "jos",
    area: "Naraguta",
  },
  {
    placeId: "jos-juth",
    name: "Jos University Teaching Hospital",
    formattedAddress: "Lamingo Road, Lamingo, Jos, Plateau",
    point: { lat: 9.91, lng: 8.86 },
    types: ["hospital", "health"],
    prominence: 0.8,
    city: "jos",
    area: "Lamingo",
  },

  // --- Bukuru / outskirts ---------------------------------------------------
  {
    placeId: "jos-bukuru-market",
    name: "Bukuru Market",
    formattedAddress: "Bukuru Expressway, Bukuru, Jos, Plateau",
    point: { lat: 9.7938, lng: 8.8676 },
    types: ["market", "shopping"],
    prominence: 0.65,
    city: "jos",
    area: "Bukuru",
  },
  {
    placeId: "jos-bukuru-junction",
    name: "Bukuru Express Junction",
    formattedAddress: "Bukuru Expressway, Bukuru, Jos, Plateau",
    point: { lat: 9.7955, lng: 8.869 },
    types: ["intersection", "route"],
    prominence: 0.45,
    city: "jos",
    area: "Bukuru",
  },
  {
    placeId: "jos-rock-haven",
    name: "Rock Haven Hotel",
    formattedAddress: "Rock Haven, Jos, Plateau",
    point: { lat: 9.862, lng: 8.858 },
    types: ["lodging", "hotel"],
    prominence: 0.4,
    city: "jos",
    area: "Rock Haven",
  },
  {
    placeId: "jos-hill-station",
    name: "Hill Station Hotel",
    formattedAddress: "Tudun Wada Road, Tudun Wada, Jos, Plateau",
    point: { lat: 9.9165, lng: 8.8845 },
    types: ["lodging", "hotel"],
    prominence: 0.7,
    city: "jos",
    area: "Tudun Wada",
  },
];

// ---------------------------------------------------------------------------
// Abuja
// ---------------------------------------------------------------------------

const ABUJA: FixturePlace[] = [
  // --- Wuse 2 cluster — the Part III worked example -------------------------
  {
    placeId: "abj-buhari-st-wuse",
    name: "Buhari Street",
    formattedAddress: "Buhari Street, Wuse 2, Abuja, FCT",
    point: { lat: 9.079, lng: 7.4625 },
    types: ["route"],
    prominence: 0.2,
    city: "abuja",
    area: "Wuse 2",
  },
  {
    placeId: "abj-wuse-mosque",
    name: "Wuse Central Mosque",
    formattedAddress: "Buhari Street, Wuse 2, Abuja, FCT",
    point: { lat: 9.0798, lng: 7.4631 },
    types: ["mosque", "place_of_worship"],
    prominence: 0.55,
    city: "abuja",
    area: "Wuse 2",
  },
  {
    // ~70 m behind the mosque — "the guest house behind the mosque on
    // Buhari Street, Wuse" should land exactly here.
    placeId: "abj-peace-guest-house",
    name: "Peace Guest House",
    formattedAddress: "Off Buhari Street, Wuse 2, Abuja, FCT",
    point: { lat: 9.0803, lng: 7.4636 },
    types: ["lodging", "guest_house"],
    prominence: 0.25,
    city: "abuja",
    area: "Wuse 2",
  },
  {
    placeId: "abj-gtbank-wuse",
    name: "GTBank Wuse 2",
    formattedAddress: "Aminu Kano Crescent, Wuse 2, Abuja, FCT",
    point: { lat: 9.0776, lng: 7.4612 },
    types: ["bank", "finance"],
    prominence: 0.6,
    city: "abuja",
    area: "Wuse 2",
  },
  {
    placeId: "abj-wuse-market",
    name: "Wuse Market",
    formattedAddress: "Herbert Macaulay Way, Wuse, Abuja, FCT",
    point: { lat: 9.064, lng: 7.457 },
    types: ["market", "shopping"],
    prominence: 0.85,
    city: "abuja",
    area: "Wuse",
  },

  // --- Garki cluster --------------------------------------------------------
  {
    placeId: "abj-garki-market",
    name: "Garki Market",
    formattedAddress: "Gimbiya Street, Garki, Abuja, FCT",
    point: { lat: 9.0325, lng: 7.4885 },
    types: ["market", "shopping"],
    prominence: 0.75,
    city: "abuja",
    area: "Garki",
  },
  {
    // Duplicate street name.
    placeId: "abj-buhari-st-garki",
    name: "Buhari Street",
    formattedAddress: "Buhari Street, Garki, Abuja, FCT",
    point: { lat: 9.0338, lng: 7.4878 },
    types: ["route"],
    prominence: 0.18,
    city: "abuja",
    area: "Garki",
  },
  {
    placeId: "abj-sahad",
    name: "Sahad Stores",
    formattedAddress: "Ahmadu Bello Way, Garki, Abuja, FCT",
    point: { lat: 9.0342, lng: 7.487 },
    types: ["supermarket", "store"],
    prominence: 0.55,
    city: "abuja",
    area: "Garki",
  },

  // --- Maitama --------------------------------------------------------------
  {
    placeId: "abj-maitama-hospital",
    name: "Maitama District Hospital",
    formattedAddress: "Aguiyi Ironsi Street, Maitama, Abuja, FCT",
    point: { lat: 9.0855, lng: 7.4903 },
    types: ["hospital", "health"],
    prominence: 0.7,
    city: "abuja",
    area: "Maitama",
  },
  {
    // Near-miss name: "Buhari Crescent", not "Buhari Street".
    placeId: "abj-buhari-cres-maitama",
    name: "Buhari Crescent",
    formattedAddress: "Buhari Crescent, Maitama, Abuja, FCT",
    point: { lat: 9.0862, lng: 7.4895 },
    types: ["route"],
    prominence: 0.15,
    city: "abuja",
    area: "Maitama",
  },
  {
    placeId: "abj-hilton",
    name: "Transcorp Hilton Abuja",
    formattedAddress: "1 Aguiyi Ironsi Street, Maitama, Abuja, FCT",
    point: { lat: 9.0745, lng: 7.488 },
    types: ["lodging", "hotel"],
    prominence: 0.95,
    city: "abuja",
    area: "Maitama",
  },

  // --- Outer ----------------------------------------------------------------
  {
    placeId: "abj-airport",
    name: "Nnamdi Azikiwe International Airport",
    formattedAddress: "Airport Road, Abuja, FCT",
    point: { lat: 9.0068, lng: 7.2632 },
    types: ["airport", "transit"],
    prominence: 0.9,
    city: "abuja",
    area: "Lugbe",
  },
  {
    placeId: "abj-nyanya-junction",
    name: "Nyanya Junction",
    formattedAddress: "Abuja-Keffi Expressway, Nyanya, Abuja, FCT",
    point: { lat: 9.0, lng: 7.56 },
    types: ["intersection", "route"],
    prominence: 0.6,
    city: "abuja",
    area: "Nyanya",
  },
  {
    placeId: "abj-jabi-lake-mall",
    name: "Jabi Lake Mall",
    formattedAddress: "Bala Sokoto Way, Jabi, Abuja, FCT",
    point: { lat: 9.0723, lng: 7.4222 },
    types: ["shopping_mall", "shopping"],
    prominence: 0.85,
    city: "abuja",
    area: "Jabi",
  },
];

export const ALL_FIXTURES: FixturePlace[] = [...JOS, ...ABUJA];

export function fixturesForCity(city?: FixtureCity): FixturePlace[] {
  if (!city) return ALL_FIXTURES;
  return ALL_FIXTURES.filter((p) => p.city === city);
}
