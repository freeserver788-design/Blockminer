# Blockmine v2

Blockmine ist ein fortschrittliches GPU-Mining-Dashboard für Windows und Linux (Debian/WSL), das sich auf Sicherheit und Effizienz konzentriert. Im Gegensatz zu anderen Tools setzt Blockmine **nur Leistungslimits** (Power-Limit) und übertaktet niemals (kein Core/Mem Clock Offset), um die Hardware zu schonen.

## Features (v2)
- **Live-Hashrate-Chart**: Verfolge deine Mining-Performance in Echtzeit.
- **Automatischer Miner-Watchdog**: Erkennt Abstürze oder hängende Pools und startet den Miner automatisch neu.
- **Thermal Guard**: Intelligenter Hitzeschutz – senkt bei Überschreitung der Zieltemperatur automatisch das Power-Limit.
- **Profit-Rechner**: Schätzung deiner Einnahmen (EUR/Tag) abzüglich Stromkosten.
- **Pool-Failover**: Hinterlege mehrere Pools; Blockmine wechselt automatisch, wenn ein Pool nicht erreichbar ist.
- **Effizienz-Metrik**: Anzeige der Hashrate pro Watt (H/W) zur Optimierung deines Setups.

## Installation & Entwicklung

### Voraussetzungen
- Node.js & npm
- Administrator-Rechte (für das Setzen von Power-Limits unter Windows)

### Starten
```bash
npm install
npm start
```

### Build (Installer erstellen)
```bash
# Windows
npm run dist

# Linux (Debian/AppImage)
npm run dist:linux
```

## Unterstützte Coins
- **GPU**: FLUX, KASPA (KAS), ERGO (ERG), ZEPHYR (ZEPH), ALEPHIUM (ALPH)
- **CPU**: MONERO (XMR)
- **SHA-256**: BITCOIN (BTC) - Built-in oder externer Miner

## Sicherheit
Blockmine ist Open-Source. Es werden keine privaten Keys oder Wallet-Daten an Dritte gesendet. Die Kommunikation findet ausschließlich zwischen deinem PC und dem gewählten Mining-Pool statt.

---
Entwickelt für Miner, die Wert auf Hardware-Langlebigkeit und einfache Bedienung legen.
