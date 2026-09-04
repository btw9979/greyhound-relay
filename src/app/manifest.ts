import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Greyhound Relay",
    short_name: "Relay",
    description: "Booth-to-sideline presnap relay for Lisbon Greyhounds football",
    start_url: "/",
    display: "standalone",
    background_color: "#0b223a",
    theme_color: "#0b223a",
    orientation: "portrait",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icons/icon-512-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
