# storage-manager

Go service that owns segment lifecycle on the recording disk: rotation, tiering (hot → warm → cold → purge), per-camera quotas, protected clips, SHA-256 chain-of-custody for exports, SMART polling.

Lands in M1/M2. M1 stub only.
