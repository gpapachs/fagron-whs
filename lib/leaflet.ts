// Leaflets (φύλλα οδηγιών): έντυπα, όχι υλικό συσκευασίας προς μεταφορά — εξαιρούνται από τις αναλύσεις.
export const isLeaflet = (description: string | null | undefined) => /LEAFLET|ΦΥΛΛΟ ΟΔΗΓΙΩΝ|ΦΥΛΛΑ ΟΔΗΓΙΩΝ/i.test(description ?? "");
