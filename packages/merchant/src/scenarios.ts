// Synthetic demo-merchant data (CLAUDE §1.3). Every record built from this file
// has source "merchant_demo" and is shown as DEMO MERCHANT DATA. None of it is
// PayPal evidence. PayPal facts (the payment, the dispute, refunds) always
// come from the sandbox API.
//
// Times are offsets in hours from the linked sandbox payment's time, so the
// story lines up with the real transaction. Events later than "now" haven't
// happened yet and are left out. So pay in the sandbox first and open the
// dispute a few days later: a delivery at +96 h needs the dispute filed at
// least 4 days after payment. See docs/DEMO_SCRIPT.md.
//
// Each scenario's amount must equal the sandbox payment amount;
// scripts/seed-demo.ts refuses to link a mismatch.

export interface ScenarioEvent {
  atHours: number;
  text: string;
  /** Carrier event only: attachable proof document (e.g. proof of delivery). */
  document?: { name: string; title: string; lines: string[] };
}

export interface Scenario {
  id: string;
  summary: string;
  order: { number: string; item: string; quantity: number; amount: string; currency: string; shipTo: string };
  shipment?: { carrier: string; tracking: string; atHours: number; events: ScenarioEvent[] };
  messages: { from: "buyer" | "seller"; atHours: number; text: string }[];
  policies: { id: string; label: string; text: string }[];
}

const RETURN_POLICY = {
  id: "returns",
  label: "Store return policy",
  text: "Returns accepted within 30 days of delivery for unused items in original packaging. Buyer pays return shipping unless the item arrived damaged.",
};

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "inr-delivered",
    summary: "Item not received, but the carrier shows delivery. Strong case.",
    order: { number: "1042", item: "Ceramic pour-over set", quantity: 1, amount: "84.00", currency: "USD", shipTo: "Austin TX 78704" },
    shipment: {
      carrier: "UPS",
      tracking: "1Z999AA10123456784",
      atHours: 20,
      events: [
        { atHours: 22, text: "Picked up, Portland OR" },
        { atHours: 50, text: "In transit, Salt Lake City UT" },
        { atHours: 74, text: "Out for delivery, Austin TX" },
        {
          atHours: 79,
          text: "Delivered, front door, Austin TX",
          document: {
            name: "proof-of-delivery-1042.pdf",
            title: "Proof of delivery - UPS 1Z999AA10123456784",
            lines: ["Carrier: UPS", "Tracking: 1Z999AA10123456784", "Status: Delivered, front door", "Destination: Austin TX 78704", "Order: #1042"],
          },
        },
      ],
    },
    messages: [{ from: "buyer", atHours: 96, text: "Hi, I still haven't received my pour-over set. Can you check?" }],
    policies: [RETURN_POLICY],
  },
  {
    id: "inr-in-transit",
    summary: "Item not received; tracking stalls in transit. Fight with gaps.",
    order: { number: "1057", item: "Linen apron, set of 2", quantity: 1, amount: "46.00", currency: "USD", shipTo: "Denver CO 80205" },
    shipment: {
      carrier: "USPS",
      tracking: "9400111899223817421234",
      atHours: 18,
      events: [
        { atHours: 26, text: "Accepted at USPS origin facility, Portland OR" },
        { atHours: 60, text: "In transit, arriving late" },
      ],
    },
    messages: [],
    policies: [RETURN_POLICY],
  },
  {
    id: "snad-color",
    summary: "Not as described (colour). Delivered; seller offered a return.",
    order: { number: "1063", item: "Hand-thrown mug pair, speckled blue", quantity: 1, amount: "58.00", currency: "USD", shipTo: "Chicago IL 60614" },
    shipment: {
      carrier: "FedEx",
      tracking: "771234567890",
      atHours: 16,
      events: [
        { atHours: 30, text: "In transit, Memphis TN" },
        { atHours: 64, text: "Delivered, left at front desk, Chicago IL" },
      ],
    },
    messages: [
      { from: "buyer", atHours: 80, text: "The mugs look more grey than blue compared to the photos." },
      {
        from: "seller",
        atHours: 83,
        text: "Sorry they're not what you expected. Glaze varies by firing, as noted on the listing. Happy to accept a return under our 30-day policy.",
      },
    ],
    policies: [
      RETURN_POLICY,
      { id: "listing-1063", label: "Listing description", text: "Speckled blue glaze. Each piece is hand-glazed; colour varies between firings and may appear grey-blue." },
    ],
  },
  {
    id: "inr-no-tracking",
    summary: "Item not received; shipped without tracking. Consider conceding.",
    order: { number: "1078", item: "Beeswax candle trio", quantity: 1, amount: "35.00", currency: "USD", shipTo: "Lagos 101241" },
    messages: [{ from: "seller", atHours: 30, text: "Your candles were posted today by standard international mail." }],
    policies: [RETURN_POLICY],
  },
];

export function scenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
