"""Process/Setup/Cycle time calculations, kept separate from the station
processing loop per the "CT, PT and ST calculations" spec — station logic
asks this class for a duration rather than computing it inline.
"""

from typing import Any, Dict, Optional


class TimingEngine:
    def get_process_time(self, config: Dict[str, Any]) -> float:
        """Process Time = t_process_end - t_process_start: the station's
        configured operation duration, unmodified (no operator-count
        division — the spec's reference Station has no operator concept)."""
        return config.get("duration", 0.0)

    def get_cycle_time(self, arrival_time: float, departure_time: float) -> float:
        """Cycle Time = departure_time - arrival_time: total elapsed time
        this entity spent at ONE station, from the moment it started
        waiting for that station (arrival) to the moment it left
        (departure) — covers wait + setup + processing + any blocking, all
        in one number, matching the spec's Station.process() example
        exactly (arrival_time before resource.request(), departure_time
        right after the station releases it)."""
        return departure_time - arrival_time

    def get_setup_time(
        self,
        config: Dict[str, Any],
        setup_matrix: Optional[Dict[str, float]],
        last_variant: Optional[str],
        variant_type: str,
    ) -> float:
        """
        Changeover time for switching a station (described by `config` —
        that station's stations_data entry) from `last_variant` to
        `variant_type`. Lookup order (per the CT/PT/ST spec's setup modes):
          1. Sequence-dependent — `setup_matrix` ({"from|to": minutes},
             keyed on lowercased variant names, that STATION's own matrix
             entries — see CsvParser.parse_setup_matrix), a pair-specific
             time.
          2. Product-dependent — config's "Setup Time by Variant" map
             ({variant: minutes}), a time that depends only on the
             INCOMING variant, regardless of what ran before it.
          3. Fixed — config's flat "Setup time" value, when neither of the
             above covers this case (also the common case of neither being
             configured at all — existing behaviour, unchanged).
        """
        if last_variant is not None and setup_matrix:
            key = f"{last_variant.lower()}|{variant_type.lower()}"
            if key in setup_matrix:
                return setup_matrix[key]
        by_variant = config.get("Setup Time by Variant")
        if by_variant:
            key = variant_type.lower()
            if key in by_variant:
                return by_variant[key]
        return config.get("Setup time", 0) or 0

    def is_batch_setup_due(
        self, config: Dict[str, Any], last_variant: Optional[str], variant_type: str
    ) -> bool:
        """
        Batch-dependent setup: `config`'s "Batch Size" (units of the SAME
        variant run back-to-back before a re-setup) and "Batch Setup Time".
        Tracks a running same-variant unit count on `config` itself
        (config["batch_unit_count"], mutated in place — config IS that
        station's live stations_data entry, so this persists across calls
        the same way last_variant_type does), reset to 0 on a variant
        change (that case is already covered by get_setup_time's ordinary
        changeover lookup, not this trigger) and incremented once per unit
        of that same variant. Returns True — and resets the counter — once
        the count reaches Batch Size. A station with Batch Size 0/blank
        never fires (existing per-changeover-only behaviour, unchanged).
        """
        batch_size = config.get("Batch Size", 0) or 0
        if batch_size <= 0:
            return False
        if last_variant is not None and variant_type != last_variant:
            config["batch_unit_count"] = 0
            return False
        count = config.get("batch_unit_count", 0) + 1
        if count >= batch_size:
            config["batch_unit_count"] = 0
            return True
        config["batch_unit_count"] = count
        return False







