"use client";

/**
 * Rich answers in the conversation: places, photos, areas, trips, traffic.
 *
 * Every card is built from a tool result, never from what the model wrote —
 * the same rule the map follows. A card showing a restaurant exists because a
 * search returned that restaurant with coordinates; the "Directions" button on
 * it routes to those coordinates directly, without asking the model anything.
 */

import {
  Bike,
  Car,
  CloudSun,
  ExternalLink,
  Footprints,
  MapPin,
  Navigation,
  TriangleAlert,
} from "lucide-react";

import type { CongestionLevel } from "@/lib/traffic/types";
import { TRAFFIC_COLOUR, TRAFFIC_LABEL } from "@/lib/traffic/colours";
import styles from "./Cards.module.css";

export interface CardPlace {
  id: string;
  name: string;
  address?: string | null;
  lat: number;
  lng: number;
  /** Road distance when known, otherwise straight-line. */
  distanceM?: number | null;
  travelText?: string | null;
  category?: string | null;
}

export interface CardImage {
  thumb: string;
  pageUrl: string;
  title: string;
}

export interface TripCardData {
  destination: string;
  mode: "driving" | "walking" | "cycling";
  durationText: string;
  distanceText: string;
  arrivalTime: string;
  via: string;
  trafficLevel: CongestionLevel;
  trafficAvailable: boolean;
  weather: string | null;
  advisory: string | null;
  incidents: number;
  alerts: number;
  safety: string[];
}

export interface RoadCardData {
  name: string;
  asked: string;
  status: "open" | "not_built" | "not_found";
  level: CongestionLevel;
  available: boolean;
  summary: string;
}

export type ChatCard =
  | { type: "places"; title: string; places: CardPlace[] }
  | { type: "place"; place: CardPlace }
  | {
      type: "web";
      title: string;
      summary: string | null;
      sourceUrl: string | null;
      images: CardImage[];
    }
  | {
      type: "area";
      name: string;
      correctedFrom: string | null;
      summary: string | null;
      sourceUrl: string | null;
      centre: CardPlace | null;
      landmarks: CardPlace[];
      roads: string[];
      junctions: string[];
    }
  | { type: "trip"; trip: TripCardData }
  | { type: "roads"; roads: RoadCardData[] }
  | {
      type: "weather";
      place: string;
      temperatureC: number;
      conditions: string;
      advisory: string | null;
    };

export interface CardsProps {
  cards: ChatCard[];
  onDirections: (place: CardPlace) => void;
  onShow: (place: CardPlace) => void;
}

function metres(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 1000) return `${Math.round(value / 10) * 10} m`;
  return `${(value / 1000).toFixed(1)} km`;
}

export default function Cards({ cards, onDirections, onShow }: CardsProps) {
  if (cards.length === 0) return null;

  return (
    <div className={styles.stack}>
      {cards.map((card, index) => (
        <CardView
          // Cards are appended per turn and never reordered.
          key={`${card.type}-${index}`}
          card={card}
          onDirections={onDirections}
          onShow={onShow}
        />
      ))}
    </div>
  );
}

function CardView({
  card,
  onDirections,
  onShow,
}: {
  card: ChatCard;
  onDirections: (place: CardPlace) => void;
  onShow: (place: CardPlace) => void;
}) {
  switch (card.type) {
    case "places":
      return (
        <section className={styles.card} aria-label={card.title}>
          <h3 className={styles.title}>{card.title}</h3>
          <ol className={styles.list}>
            {card.places.slice(0, 6).map((place, index) => (
              <li key={place.id} className={styles.row}>
                <button type="button" className={styles.rowMain} onClick={() => onShow(place)}>
                  <span className={styles.rank} aria-hidden="true">
                    {index + 1}
                  </span>
                  <span className={styles.rowText}>
                    <span className={styles.rowName}>{place.name}</span>
                    <span className={styles.rowMeta}>
                      {[place.travelText, metres(place.distanceM), place.address]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.go}
                  onClick={() => onDirections(place)}
                  title={`Directions to ${place.name}`}
                >
                  <Navigation size={14} aria-hidden="true" />
                  Go
                </button>
              </li>
            ))}
          </ol>
        </section>
      );

    case "place":
      return (
        <section className={styles.card} aria-label={card.place.name}>
          <div className={styles.placeHead}>
            <span className={styles.placeIcon} aria-hidden="true">
              <MapPin size={16} />
            </span>
            <span className={styles.rowText}>
              <span className={styles.rowName}>{card.place.name}</span>
              <span className={styles.rowMeta}>
                {[metres(card.place.distanceM), card.place.address].filter(Boolean).join(" · ")}
              </span>
            </span>
          </div>
          <div className={styles.actions}>
            <button type="button" className={styles.primary} onClick={() => onDirections(card.place)}>
              <Navigation size={15} aria-hidden="true" />
              Directions
            </button>
            <button type="button" className={styles.secondary} onClick={() => onShow(card.place)}>
              Show on map
            </button>
          </div>
        </section>
      );

    case "web":
      return (
        <section className={styles.card} aria-label={`About ${card.title}`}>
          {card.images.length > 0 && (
            <div className={styles.gallery}>
              {card.images.map((image) => (
                <a
                  key={image.thumb}
                  href={image.pageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.photo}
                  title={`${image.title} — photo credit and licence on Wikimedia`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={image.thumb} alt={image.title} loading="lazy" referrerPolicy="no-referrer" />
                </a>
              ))}
            </div>
          )}
          <h3 className={styles.title}>{card.title}</h3>
          {card.summary && <p className={styles.summary}>{card.summary}</p>}
          <p className={styles.credit}>
            {card.images.length > 0 ? "Photos: Wikimedia Commons, tap for credit. " : ""}
            {card.sourceUrl && (
              <a href={card.sourceUrl} target="_blank" rel="noopener noreferrer">
                Wikipedia <ExternalLink size={11} aria-hidden="true" />
              </a>
            )}
          </p>
        </section>
      );

    case "area":
      return (
        <section className={styles.card} aria-label={card.name}>
          {card.correctedFrom && (
            <p className={styles.correction}>
              Showing results for <strong>{card.name}</strong> — you typed &ldquo;{card.correctedFrom}&rdquo;.
            </p>
          )}
          <h3 className={styles.title}>{card.name}</h3>
          {card.summary && <p className={styles.summary}>{card.summary}</p>}

          {card.landmarks.length > 0 && (
            <>
              <h4 className={styles.subTitle}>Landmarks</h4>
              <div className={styles.chips}>
                {card.landmarks.slice(0, 8).map((landmark) => (
                  <button
                    key={landmark.id}
                    type="button"
                    className={styles.chip}
                    onClick={() => onShow(landmark)}
                    title={landmark.category ?? undefined}
                  >
                    {landmark.name}
                  </button>
                ))}
              </div>
            </>
          )}

          {(card.roads.length > 0 || card.junctions.length > 0) && (
            <p className={styles.rowMeta}>
              {[...card.roads.slice(0, 4), ...card.junctions.slice(0, 3)].join(" · ")}
            </p>
          )}

          {card.centre && (
            <div className={styles.actions}>
              <button type="button" className={styles.primary} onClick={() => onDirections(card.centre!)}>
                <Navigation size={15} aria-hidden="true" />
                Directions to {card.name}
              </button>
            </div>
          )}
        </section>
      );

    case "trip": {
      const trip = card.trip;
      const ModeIcon = trip.mode === "walking" ? Footprints : trip.mode === "cycling" ? Bike : Car;
      return (
        <section className={styles.card} aria-label={`Trip to ${trip.destination}`}>
          <div className={styles.tripHead}>
            <span className={styles.tripTime}>{trip.durationText}</span>
            <span className={styles.rowMeta}>
              {trip.distanceText} · arrive {trip.arrivalTime}
            </span>
            <ModeIcon size={18} className={styles.tripMode} aria-label={trip.mode} />
          </div>
          <p className={styles.rowMeta}>
            To {trip.destination}
            {trip.via.startsWith("via ") ? ` ${trip.via}` : ""}
          </p>

          <div className={styles.facts}>
            {trip.mode !== "walking" && (
              <span className={styles.fact}>
                <span
                  className={styles.dot}
                  style={{ background: TRAFFIC_COLOUR[trip.trafficAvailable ? trip.trafficLevel : "unknown"] }}
                  aria-hidden="true"
                />
                {trip.trafficAvailable ? `${TRAFFIC_LABEL[trip.trafficLevel]} traffic` : "No live traffic"}
              </span>
            )}
            {trip.weather && (
              <span className={styles.fact}>
                <CloudSun size={13} aria-hidden="true" />
                {trip.weather}
              </span>
            )}
            <span className={styles.fact}>
              <TriangleAlert size={13} aria-hidden="true" />
              {trip.incidents === 0 ? "No reported incidents" : `${trip.incidents} report${trip.incidents === 1 ? "" : "s"} on route`}
            </span>
          </div>

          {(trip.advisory || trip.safety.length > 0) && (
            <ul className={styles.safety}>
              {trip.advisory && <li>{trip.advisory}</li>}
              {trip.safety.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
        </section>
      );
    }

    case "roads":
      return (
        <section className={styles.card} aria-label="Road traffic">
          <h3 className={styles.title}>Road traffic</h3>
          <ul className={styles.list}>
            {card.roads.map((road) => {
              const level = road.status === "open" && road.available ? road.level : "unknown";
              return (
                <li key={`${road.asked}-${road.name}`} className={styles.roadRow}>
                  <span className={styles.dot} style={{ background: TRAFFIC_COLOUR[level] }} aria-hidden="true" />
                  <span className={styles.rowText}>
                    <span className={styles.rowName}>{road.name}</span>
                    <span className={styles.rowMeta}>{road.summary}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      );

    case "weather":
      return (
        <section className={styles.card} aria-label={`Weather in ${card.place}`}>
          <div className={styles.placeHead}>
            <span className={styles.placeIcon} aria-hidden="true">
              <CloudSun size={16} />
            </span>
            <span className={styles.rowText}>
              <span className={styles.rowName}>
                {card.temperatureC}° · {card.conditions}
              </span>
              <span className={styles.rowMeta}>{card.place}</span>
            </span>
          </div>
          {card.advisory && <p className={styles.correction}>{card.advisory}</p>}
        </section>
      );

    default:
      return null;
  }
}
