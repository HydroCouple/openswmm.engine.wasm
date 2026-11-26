// The 2D surface: inspect the mesh, edit it before initialize(), force rain, read cell arrays.
//
//   node docs/examples/surface2d.mjs
//
// Uses examples/trivial_2d.inp: a 100 m x 100 m plane, two triangles, one outflow edge.
import { readFileSync } from "node:fs";

import createOpenSwmmModule from "@hydrocouple/openswmm-engine-wasm/wasm";
import { Solver } from "@hydrocouple/openswmm-engine-wasm";

const inp = readFileSync(new URL("../../examples/trivial_2d.inp", import.meta.url), "utf8");
const mod = await createOpenSwmmModule();
const solver = new Solver(mod);
solver.writeFile("/plane.inp", inp);
solver.open("/plane.inp", "/plane.rpt", "/plane.out");

const mesh = solver.surface2d;
mesh.setTriangleMannings(1, 0.05); // edits to the mesh go before initialize()
solver.initialize(); // builds the 2D state; the surface is active from here on

const { x, y, z } = mesh.getVertexCoords(); // m
console.log(`active ${mesh.isActive}: ${mesh.nVertices} vertices, ${mesh.nCells} cells`);
console.log("vertex 2:", x[2], y[2], z[2], "| cell 0 area:", mesh.getTriangleArea(0), "m²");
console.log("Manning's n:", mesh.getTriangleMannings(0), mesh.getTriangleMannings(1));

solver.start();
solver.advanceTo(900); // 15 minutes of the model's own rain
mesh.forceRainfallUniform(2e-5); // m/s on every cell, for the next step only
solver.step();
const depths = Array.from(mesh.getDepths(), (d) => d.toFixed(5));
console.log("depths at 15 min (m):", depths);
const [vx, vy] = mesh.getVelocities(); // m/s, one value per cell
console.log("velocity of cell 0 (m/s):", vx[0].toFixed(4), vy[0].toFixed(4));

while (solver.step() > 0);
const { rainfallIn, boundaryOut, continuityError } = mesh.getMassBalance(); // m³, a fraction
console.log(`rain in ${rainfallIn.toFixed(3)} m³, out ${boundaryOut.toFixed(3)} m³`);
console.log(`continuity error ${(100 * continuityError).toExponential(2)} %`);

solver.end();
solver.close();
solver.destroy();
