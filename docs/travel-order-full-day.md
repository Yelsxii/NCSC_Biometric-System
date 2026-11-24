# Full-day Travel Order monitoring

For the current office workflow, every explicitly recorded Travel Order is displayed across all four regular AM/PM clock columns in one cell. A separate Travel Order column also identifies the status. No half-day rule is applied. This is monitoring of recorded activity, not independent approval of a travel claim.

Source evidence (a named DTR note, recorded official reference, or mapped work code in an imported scan) is retained. Raw regular scans and source times on a travel day are not deleted; they are accessible in the editor's evidence details and flagged for review. No travel-day attendance hours, undertime or overtime are inferred. The compact travel editor does not require AM/PM entries.

The standard K14 LAN poller still lacks verified work codes. Run the read-only `python -m app.cli inspect-bionet-workcodes` against the configured ZKBio database to check definitions and counts. That diagnostic does not import codes or automatically classify new vendor records. Do not infer code numbers or fabricate timestamps.
