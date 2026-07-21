#!/usr/bin/env python3
"""
Google Maps lead scraper for FOFUS 3D Prints.

Finds local businesses in Kerala/Thrissur area that may need 3D printing
(prototypes, gifts, signage, event decor, architectural models, molds, etc.)
and extracts name, phone, website, address, and category.

Uses Google Places API (New) — requires a GOOGLE_MAPS_API_KEY.
Output: CSV + JSON.

Usage:
    export GOOGLE_MAPS_API_KEY=...
    python3 maps_lead_scraper.py --city "Thrissur" --radius 15000 --limit 200
    python3 maps_lead_scraper.py --city "Kochi" --radius 20000 --limit 200

Target business types:
- architects, interior designers
- gift shops, trophy / award shops
- event planners, wedding planners
- schools, colleges, makerspaces
- temples / religious institutions (idol donors)
- candle / soap / chocolatiers (mold buyers)
- product designers, hardware startups
- jewellery designers (prototyping)
- sign board / advertising agencies
"""

import argparse
import csv
import json
import os
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import List, Dict

API_KEY = os.environ.get("GOOGLE_MAPS_API_KEY")
BASE_URL = "https://places.googleapis.com/v1/places:searchText"

QUERIES = [
    "architects in {city}",
    "interior designers in {city}",
    "gift shops in {city}",
    "trophy shops in {city}",
    "event planners in {city}",
    "wedding planners in {city}",
    "schools in {city}",
    "engineering colleges in {city}",
    "temples in {city}",
    "candle makers in {city}",
    "soap makers in {city}",
    "jewellery designers in {city}",
    "product design studios in {city}",
    "sign board manufacturers in {city}",
    "advertising agencies in {city}",
    "hardware startups in {city}",
]


def search_places(query: str, limit: int = 20, next_token: str = None) -> Dict:
    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": API_KEY,
        "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.internationalPhoneNumber,places.websiteUri,places.types,places.rating,places.userRatingCount,places.googleMapsUri,nextPageToken",
    }
    payload = {
        "textQuery": query,
        "pageSize": min(limit, 20),
    }
    if next_token:
        payload["pageToken"] = next_token

    req = urllib.request.Request(
        BASE_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def scrape_city(city: str, radius: int, limit: int) -> List[Dict]:
    results = []
    seen_phones = set()
    per_query_limit = max(1, min(20, limit // len(QUERIES)))

    for qtmpl in QUERIES:
        query = qtmpl.format(city=city)
        print(f"Searching: {query}")
        try:
            data = search_places(query, limit=per_query_limit)
        except Exception as e:
            print(f"  Error: {e}")
            continue

        places = data.get("places", [])
        for p in places:
            display_name = p.get("displayName") or {}
            phone = (p.get("internationalPhoneNumber") or "").strip()
            if phone and phone in seen_phones:
                continue
            if phone:
                seen_phones.add(phone)

            rec = {
                "name": display_name.get("text", ""),
                "category": ", ".join(p.get("types", [])),
                "address": p.get("formattedAddress", ""),
                "phone": phone,
                "website": p.get("websiteUri", ""),
                "maps_url": p.get("googleMapsUri", ""),
                "rating": p.get("rating", ""),
                "reviews": p.get("userRatingCount", ""),
                "city": city,
                "query": query,
            }
            results.append(rec)

        time.sleep(0.5)

    print(f"Total unique leads for {city}: {len(results)}")
    return results


def save(results: List[Dict], out_dir: Path, city: str):
    out_dir.mkdir(parents=True, exist_ok=True)
    safe_city = city.replace(" ", "_").lower()

    json_path = out_dir / f"leads_{safe_city}.json"
    csv_path = out_dir / f"leads_{safe_city}.csv"

    with json_path.open("w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    if results:
        with csv_path.open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=results[0].keys())
            writer.writeheader()
            writer.writerows(results)

    print(f"Saved: {json_path} and {csv_path}")


def main():
    parser = argparse.ArgumentParser(description="Google Maps lead scraper for FOFUS")
    parser.add_argument("--city", default="Thrissur", help="City to search")
    parser.add_argument("--radius", type=int, default=15000, help="Radius in meters (not used in text search, kept for compatibility)")
    parser.add_argument("--limit", type=int, default=200, help="Approximate total lead target")
    parser.add_argument("--out", default="/home/reventer/work/fofus-quote/leads", help="Output directory")
    args = parser.parse_args()

    if not API_KEY:
        print("ERROR: Set GOOGLE_MAPS_API_KEY environment variable")
        return 1

    leads = scrape_city(args.city, args.radius, args.limit)
    save(leads, Path(args.out), args.city)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
