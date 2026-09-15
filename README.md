# Blockmine v3

Blockmine v3 ist ein professionelles Electron-Dashboard für sicheres GPU- und CPU-Mining. Die Oberfläche ist auf schnelle Entscheidungen im laufenden Betrieb ausgelegt: Live-Telemetrie, Power-Limit, Miner-Steuerung, Watchdog, Thermal Guard, Failover-Pools, Profit-Schätzung und Mining-Verlauf arbeiten in einem ruhigen Operations-Layout zusammen.

## Was in v3 neu ist

- Operations Control Center mit Live-KPIs für Temperatur, Leistungsaufnahme, Hashrate und Effizienz.
- Quick Actions für Mining und das Balanced-Power-Profil.
- Failover-Pools direkt in der Mining-Konfiguration, jeweils ein Pool pro Zeile.
- Stabilere Miner-Zustände und sauberer Neustart nach Watchdog-/Failover-Aktionen.
- Korrekte VRAM-Einheiten auch bei WMI-/AMD-/Intel-Fallback-Daten.
- Professionelles, code-basiertes UI ohne externe Design- oder KI-Abhängigkeiten.
- Bestehende Sicherheitslogik bleibt erhalten: Blockmine setzt nur Power-Limits und verändert keine Clocks oder Spannungen.

## Entwicklung

Voraussetzungen: Node.js, npm und unter Windows für Power-Limits die passenden NVIDIA-Treiber bzw. Administrator-Rechte.

```bash
npm install
npm start
```

Installer bauen:

```bash
npm run dist       # Windows
npm run dist:linux # Linux
```

## Sourcecode-Branch

Der Branch `Sourcecode` enthält ausschließlich den vollständigen aktuellen v3-Stand. Der Code ist direkt in den Projektordnern `renderer/`, `lib/`, `miner/`, `build/` und `dcimage/` organisiert — keine alten v1/v2-Duplikate.

## Sicherheit

Blockmine speichert keine privaten Keys und sendet keine Wallet-Geheimnisse an Blockmine-Server. Pool-Kommunikation findet nur mit dem vom Nutzer ausgewählten Pool statt. Wallet-Adressen werden vor dem Start lokal auf ein plausibles Format geprüft.

Lizenz: MIT.
