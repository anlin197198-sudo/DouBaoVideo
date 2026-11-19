import assert from "node:assert/strict";
import { test } from "node:test";
import { viewportForTarget } from "../src/shared/canvas-focus";
test("intentional offscreen focus preserves zoom and input data, and repeated focus is stationary",()=>{
 for(const zoom of [.1,.7,1,4]){
 const viewport={x:-500,y:300,zoom},host={width:1000,height:700},target={position:{x:90000,y:-1200},width:240,height:330};
 const before=structuredClone({viewport,host,target});const next=viewportForTarget(viewport,host,target)!;
 assert.equal(next.zoom,zoom);assert.equal((target.position.x+120)*zoom+next.x,500);assert.equal((target.position.y+165)*zoom+next.y,350);
 assert.equal(viewportForTarget(next,host,target),null);assert.deepEqual({viewport,host,target},before);
 }
});
test("visible, missing, nonfinite and unmounted host targets never move",()=>{
 const viewport={x:10,y:20,zoom:1},host={width:1000,height:700},target={position:{x:20,y:30},width:240,height:330};
 assert.equal(viewportForTarget(viewport,host,target),null);assert.equal(viewportForTarget(viewport,host,null),null);
 for(const width of [0,-1,NaN,Infinity])assert.equal(viewportForTarget(viewport,{...host,width},target),null);
 assert.equal(viewportForTarget({...viewport,zoom:NaN},host,target),null);
 assert.equal(viewportForTarget(viewport,host,{...target,position:{x:Infinity,y:0}}),null);
 assert.equal(viewportForTarget(viewport,host,{...target,width:0}),null);
});
test("partially clipped nodes center without zoom-to-fit; oversized nodes stay stable",()=>{
 const host={width:500,height:300},target={position:{x:-20,y:100},width:1000,height:800};
 const next=viewportForTarget({x:0,y:0,zoom:2},host,target)!;assert.equal(next.zoom,2);
 assert.equal(viewportForTarget(next,host,target),null);
 const small={position:{x:490,y:0},width:30,height:30};assert.ok(viewportForTarget({x:0,y:0,zoom:1},host,small));
});
test("remaining width excludes sidebar occlusion without changing zoom",()=>{
 const viewport={x:0,y:0,zoom:.5},target={position:{x:1100,y:100},width:240,height:330};
 assert.equal(viewportForTarget(viewport,{width:1000,height:600},target),null);
 const next=viewportForTarget(viewport,{width:500,height:600},target)!;
 assert.equal(next.zoom,.5);assert.equal((target.position.x+120)*next.zoom+next.x,250);
 assert.equal(viewportForTarget(next,{width:500,height:600},target),null);
});
