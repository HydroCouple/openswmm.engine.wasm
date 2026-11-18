/**
 * Decks shared by the real-module tests, copied from the engine's Python
 * tests so both suites exercise the same models.
 */

/** MODEL of python/tests/engine/_groundwater_cases.py. */
export const MIXED_CELL_MODEL = `[OPTIONS]
FLOW_UNITS CMS
FLOW_ROUTING DYNWAVE
START_DATE 01/01/2026
START_TIME 00:00:00
END_DATE 01/01/2026
END_TIME 00:10:00
REPORT_STEP 00:01:00
WET_STEP 00:01:00
ROUTING_STEP 5
[POLLUTANTS]
TSS MG/L 0 0 0 0
[JUNCTIONS]
J1 -2 4 0 0 0
[OUTFALLS]
O1 -2.5 FREE NO
[CONDUITS]
C1 J1 O1 30 0.013 0 0 0
[XSECTIONS]
C1 CIRCULAR 0.5 0 0 0 1
[TIMESERIES]
INPUT 0:00 0.5
INPUT 1:00 0.5
[2D_OPTIONS]
INTEGRATOR EXPLICIT
LTS_TIERS 2
MAX_TIMESTEP 5
DRY_DEPTH 0.001
REPORT_2D NO
RAINFALL_MODE SYSTEM
[2D_VERTICES]
0 0 0
10 0 0
10 10 0
0 10 0
20 0 0
[2D_TRIANGLES]
1 4 2 0.03 0.1 FAR
[2D_QUADS]
0 1 2 3 0.03 0.1 PAN
[REPORT]
INPUT NO
`;

/** The `.rxn` of python/tests/engine/test_reactions.py (`_reactions_model`). */
export const REACTIONS_RXN = `[REACTION_OPTIONS]
RATE_UNITS SEC
[REACTION_SPECIES]
BULK X MG
BULK Y MG
[REACTION_COEFFICIENTS]
CONSTANT Kb 0.05
[REACTION_TERMS]
Kf 0.5 * DT
[REACTION_PIPES]
RATE X -Kb * Kf * X
RATE Y -Kb * X
[REACTION_TANKS]
RATE X -Kb * X
RATE Y 0
[REACTION_QUALITY]
GLOBAL X 8
`;

/** Text that parses as `.rxn` but does not compile (from the same Python test). */
export const UNCOMPILABLE_RXN = `[REACTION_OPTIONS]
RATE_UNITS SEC
[REACTION_SPECIES]
BULK Z MG
[REACTION_PIPES]
RATE Z -NO_SUCH_COEF * Z
`;

/** The reaction-enabled `.inp` of the same Python test, bound to `rxnName`. */
export function reactionsInp(rxnName: string): string {
  return `[TITLE]
Python reactions-binding round-trip deck

[OPTIONS]
FLOW_UNITS           CFS
FLOW_ROUTING         DYNWAVE
QUALITY_SOLVER       EULERIAN_ARD
START_DATE           01/01/2026
START_TIME           00:00:00
END_DATE             01/01/2026
END_TIME             01:00:00
ROUTING_STEP         5
REPORT_STEP          00:05:00

[JUNCTIONS]
;;Name Elev MaxDepth InitDepth SurDepth Aponded
J0  10.0  10  1.5  0  0
J1   9.4  10  1.5  0  0

[OUTFALLS]
OUT  7.0  FREE  NO

[CONDUITS]
C1  J0  J1   500  0.013  0  0  0
C2  J1  OUT  500  0.013  0  0  0

[XSECTIONS]
C1  CIRCULAR  2.0  0  0  0
C2  CIRCULAR  2.0  0  0  0

[INFLOWS]
J0  FLOW  ""  FLOW  1.0  1.0  5

[POLLUTANTS]
;;Name Units Crain Cgw Crdii Kdecay SnowOnly CoPollut CoFrac Cdwf Cinit
TSS   MG/L  0  0  0  0  NO  *  0  0  10

[PROCESS_COMPONENTS]
org.hydrocouple.openswmm.reactions config="${rxnName}"

[REPORT]
INPUT NO
`;
}
