# Health memory validation on Railway

This experiment uses the existing `agentmemory` project and its isolated `sandbox` environment. It does not use production data or Railway's ephemeral sandbox product.

## Environment and artifacts

- Isolated `sandbox` deployment environment; no production data used.
- Linux cgroup v2, Node `v22.23.2`, iii engine and iii-sdk `0.11.2`.
- One Singapore replica, two vCPUs, `memory.max=8589934592` (8 GiB), `memory.high=max`, swap disabled.
- `NODE_OPTIONS=--max-old-space-size=6144`; observed V8 `heap_size_limit=6492782592`.
- Node, iii and the synthetic sibling allocator all report `0::/`. The visible cgroup mount is the namespace root. Hidden ancestor controls cannot be inspected from this container.
- Fresh ephemeral `/data`; the retained volume remained unattached and was never mounted by experimental code.
- No LLM/embedding API credentials, embedding provider or embedding shim: successful observation writes validate the provider-free path.
- Platform healthcheck remains `/agentmemory/livez`, with a 300-second startup timeout.

The tested candidate runtime is commit `d16213721e2e0151a2904c08e8c2e9dde3ec3521`. Later commits include documentation and unrelated log/provider/GC changes validated separately by local regression tests; this live experiment does not claim their complete bundle matches the measured image. The baseline and current variants use source `42bcdce85eacb770ecf45c7315168f8be312d0b4`. The baseline changes only `heapCeiling` back to `snapshot.memory.heapTotal` in `evaluateHealth`, recreating the defect without comparing unrelated releases. Test-only code and builds stay outside the PR.

Runtime dependency lock SHA-256: `9030232b4f6092ec74f351b61859b99f1cbf9e22a7bfe09ecce11152d6668ed2`. Subsequent builds use this lock; compare the resolved dependency version maps, because package tarball integrity changes with source. Record each image digest and installed `dist/index.mjs` hash separately.

## Workload

A test-only module imported by the application worker retains 640 MiB of JavaScript numbers in 8 MiB arrays, retains a touched 64 MiB Buffer, and starts a sibling Node process with another touched 64 MiB Buffer. Each second it replaces an 8 MiB array to create ordinary allocation/GC churn. The sibling's cgroup membership is verified rather than assumed.

After at least 65 seconds of warm-up, take 31 samples at 30-second intervals: a full 15-minute first-to-last window. For every sample, capture `/health` HTTP status and JSON from the same response; capture `/livez`, a successful synthetic `/observe` write, worker memory, V8 limit, cgroup current/max/high/swap, memory.events and PSI. Verify health `uptimeSeconds` advances so repeated polls cannot masquerade as fresh collection.

The initial single-array experiment is excluded from the comparison. One very large JS array caused transient V8 allocation overhead; every accepted run uses the same bounded 8 MiB chunks.

## Results

| Variant | Fresh samples / duration | Health | Liveness / observations | Heap used / committed | Heap used / V8 limit |
|---|---|---|---|---|---|
| Reintroduced baseline | 31 / 15m0.406s | 31 × 503, memory-critical | 31 × 200 / 31 × 201 | 95.058–96.972% | 10.807–18.682% |
| Existing PR #1224 | 31 / 15m10.920s | 31 × 200, healthy | 31 × 200 / 31 × 201 | 95.031–97.670% | 10.808–23.731% |
| Candidate `d16213721e2e0151a2904c08e8c2e9dde3ec3521` | 31 / 15m0.409s | 31 × 200, healthy | 31 × 200 / 31 × 201 | 95.203–97.482% | 10.939–19.725% |

All three variants used identical Node/iii versions and the same 232 resolved package versions. Every paired response had matching body status and HTTP code, every health uptime was unique, and no cgroup memory event or PSI total increased.

| Variant | Image digest | Installed `dist/index.mjs` SHA-256 |
|---|---|---|
| Baseline | `sha256:f48371808108061acb706f71760f082868919865871d1a65f91b0ad88318ef43` | `f555f9f2558e4a6f1d7795fe95ea904559d1954f719a68a7becdb3146421a048` |
| Current PR | `sha256:13b14bbb5d24ad737cee9b16ad134475a1c64b0509585873a826209ff8f63abb` | `e824533a643bf28b96eb110d8b51822c5f1fabbc33f85c7f349f57a44bccac46` |
| Candidate | `sha256:2fadeee1e7995a6ca4d90654022c15b7999ef2f63a196c814276fe89eb668d14` | `ec8af71563960e3ca0f4bd4c34d3a0c15d3e915b026a2e0e05e5d6c999610459` |

Workload module SHA-256: `f8ace48d97343665518729861de6506deb80cdff7142489266382cce27676f9e`.

## Controlled transition and file-cache checks

The hold test produced 97 paired polls over eight fresh collector snapshots. Both heap and cgroup-max entered pending pressure at 06:38:34 UTC (degraded, HTTP 200, sample 1/2), became critical at 06:39:03 (HTTP 503), remained critical on the first clear snapshot at 06:40:04 (recovering, sample 1/2), and recovered at 06:40:33 (healthy, HTTP 200). Repeated polls within a snapshot did not advance either transition counter. Both runs use the same candidate image with sandbox-only warning/critical thresholds of 3%/5%, keeping actual use far below the 8 GiB cap. Preliminary transition recovery and cache output is excluded: the first test-only forced-GC helper used unsupported dynamic import in an inspector expression. The corrected helper calls `HeapProfiler.collectGarbage`; application code and the allocation module are unchanged. Clearing the control file drops bulk heap/native/sibling allocations but retains the last 8 MiB churn array until process stop, explaining the approximately 31 MiB recovery heap floor.

The separate file-cache test produced 97 paired polls over seven fresh snapshots. Writing a 512 MiB disposable file moved cgroup occupancy to approximately 7.5% while heap use stayed approximately 0.5%. Cgroup-max entered pending pressure at 06:42:03 UTC, became critical at 06:42:33, entered recovery after unlinking the file at 06:43:34, and returned healthy at 06:44:04. Heap remained healthy throughout. Every controlled poll returned liveness 200 and observation 201; all body/HTTP mappings matched, and memory.events, PSI totals and swap remained zero.

Controlled-phase helper SHA-256:

- `force-gc.mjs`: `938c878c2158de38b2c55a1f36434ccd1444411747a35f9b49f1109dd26a44e9`
- `hold-samples.mjs`: `5453cdb068d5ed6fd0657ec23c57425ce658350c77931af221c6ad7921ffec52`
- `cache-samples.mjs`: `95f3948ddcd60f7303b0a57cdb7b99ce3b13f0abeb6180132145f95c0aa72321`

### Operational correction

Railway CLI 5.27 treats service source disconnect as service-wide even with an environment argument. Using it during sandbox setup removed a shared production source binding. It was restored with an environment-scoped patch and `skipDeploys:true`; configuration read-back and unchanged production deployment identities verified the correction without a production deployment. Private incident records retain the exact scope and evidence.

## Limitations

This is a synthetic workload on a fresh store. It does not establish retained-corpus capacity or production startup performance. The live environment exposes neither finite `memory.high` nor nested systemd ancestor controls; those cases are covered by filesystem fixtures. Cgroup v1 and hidden ancestors remain unsupported/unobservable as documented. Cgroup filesystem reads have no explicit timeout; the Docker engine observer itself has no retry mechanism. Lowered thresholds test transitions without deliberately approaching physical OOM. `memory.current` includes reclaimable file cache: current/max evaluates configured capacity occupancy, not proof that an allocation would fail or that OOM is imminent.

## Cleanup

Bulk synthetic allocations and the disposable cache file were removed, and test-only threshold overrides were deleted with `skipDeploys:true`. Railway normalized a last-region scale-to-zero request into its default region with one configured replica; the resulting sandbox deployment was canceled and the measured sandbox deployment stopped explicitly. Final read-back verifies no active sandbox deployment or running instance. The final 8 MiB churn array disappears with process stop. Service/configuration and artifact evidence remain; the retained volume stays READY and unattached. Production source/trigger configuration and both production deployment identities remain unchanged. Configured replica defaults remain present; this cleanup establishes an inactive sandbox rather than claiming a persisted zero-replica configuration.

## Reproducing the deterministic checks

```sh
npx vitest run test/health-memory.test.ts test/health-collection.test.ts test/health-monitor.test.ts test/health-thresholds.test.ts
npm test
npm run build
```

For another live comparison, export each recorded source to its own build context, reuse the dependency lock, add the same test-only worker allocation module, and deploy only to an isolated environment. Keep provider configuration, V8 limit, cgroup cap, replica count and warm-up unchanged. Test code must never be imported by a production build. API authentication must be read inside the container; do not print the generated HMAC secret.

At the end of steady-state sampling, redeploy the exact candidate image with sandbox-only `AGENTMEMORY_HEALTH_MEM_WARN_PCT=3` and `AGENTMEMORY_HEALTH_MEM_CRITICAL_PCT=5`. Start before bulk test allocations, then apply the bounded workload. Polling faster than the collector must leave each snapshot's transition count unchanged. Remove bulk heap/native/sibling allocations and explicitly GC the worker only for this controlled test; verify recovery requires two fresh collector samples. Delete the test-only threshold overrides afterward.

### Exact test-only allocation module

The following is the frozen module used for the recorded measurements and workload hash above. In an isolated source export, save it as `src/repro-runtime.ts`, apply the required publication patch below, then add `import "./repro-runtime.js";` to `src/index.ts` before building. This import belongs only in the disposable experiment build, never in the application PR. The module collects diagnostics every second and adds bulk allocations only when its control file requests them.

```typescript
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { getHeapStatistics } from 'node:v8';
import { spawn, type ChildProcess } from 'node:child_process';
let heap: number[][] = [];
let native: Buffer | undefined;
let child: ChildProcess | undefined;
let previous = '';
let churn: number[] = [];
const read = (p: string) => { try { return readFileSync(p, 'utf8').trim(); } catch { return null; } };
setInterval(() => {
  const control = read('/tmp/health-repro-control.json') || '{}';
  if (control !== previous) {
    const config = JSON.parse(control);
    heap = Array.from({length:Math.ceil((config.heapMiB || 0)/8)},()=>new Array(1024*1024).fill(0.25));
    native = config.nativeMiB ? Buffer.alloc(config.nativeMiB * 1024 * 1024, 0x5a) : undefined;
    child?.kill(); child = undefined;
    if (config.siblingMiB) child = spawn(process.execPath, ['-e', `const b=Buffer.alloc(${config.siblingMiB}*1024*1024,0x55);setInterval(()=>{if(!b[0])process.exit(1)},1000)`], { stdio: 'ignore', env: { ...process.env, NODE_OPTIONS: '' } });
    previous = control;
  }
  if (heap.length) churn = new Array(1024 * 1024).fill(Math.random());
  const processes = readdirSync('/proc').filter(p => /^\d+$/.test(p)).map(pid => ({pid, comm:read(`/proc/${pid}/comm`), cgroup:read(`/proc/${pid}/cgroup`), status:read(`/proc/${pid}/status`)?.split('\n').filter(l=>/^(VmRSS|VmSize|Name|PPid):/.test(l))}));
  const cgroup = Object.fromEntries(['memory.current','memory.max','memory.high','memory.events','memory.pressure','memory.swap.current','memory.swap.max'].map(f => [f,read(`/sys/fs/cgroup/${f}`)]));
  writeFileSync('/tmp/health-repro-diagnostics.json',JSON.stringify({timestamp:new Date().toISOString(),deploymentId:process.env.RAILWAY_DEPLOYMENT_ID,variant:process.env.HEALTH_REPRO_VARIANT,pid:process.pid,node:process.version,versions:process.versions,nodeOptions:process.env.NODE_OPTIONS,memory:process.memoryUsage(),heapSizeLimit:getHeapStatistics().heap_size_limit,allocations:{heapElements:heap.length * 1024 * 1024,nativeBytes:native?.length||0,churnElements:churn.length,siblingPid:child?.pid},cgroup,processes,mountinfo:read('/proc/self/mountinfo')?.split('\n').filter(l=>l.includes('cgroup'))}));
}, 1000).unref();
```

### Required diagnostics publication patch for new runs

The measured module truncates the diagnostics file while rewriting it, so another process can read partial JSON. Before building any new experiment, run this patch in its isolated source export. It writes diagnostics to a temporary file in the same directory, then atomically renames it over the reader-visible path. All diagnostics readers then receive a complete previous or current snapshot.

This changes only diagnostics publication. The original module, hash and recorded measurements above remain historical evidence; the patched module has a different hash and has not been measured in those runs. Record the printed hash with each new run and use the patched module consistently across its variants.

```sh
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const file = 'src/repro-runtime.ts';
let source = readFileSync(file, 'utf8');
if (createHash('sha256').update(source).digest('hex') !== 'f8ace48d97343665518729861de6506deb80cdff7142489266382cce27676f9e') {
  throw new Error('Expected the exact measured allocation module before patching');
}
source = source
  .replace('writeFileSync, readdirSync', 'writeFileSync, renameSync, readdirSync')
  .replace("writeFileSync('/tmp/health-repro-diagnostics.json',", "writeFileSync('/tmp/health-repro-diagnostics.next',")
  .replace('\n}, 1000).unref();', "\n  renameSync('/tmp/health-repro-diagnostics.next', '/tmp/health-repro-diagnostics.json');\n}, 1000).unref();");
writeFileSync(file, source);
console.log('Atomic-publication workload SHA-256:', createHash('sha256').update(source).digest('hex'));
NODE
```

### Steady-state sampler

Save the following as `/tmp/health-repro-sample.mjs` inside the sandbox container. It reads authentication locally and prints only response/diagnostic evidence.

```javascript
import {readFileSync,writeFileSync} from 'node:fs';
const secret=readFileSync('/data/.hmac','utf8').trim();
const variant=process.argv[2]||'current';
const count=Number(process.argv[3]||30);
const headers={authorization:`Bearer ${secret}`,'content-type':'application/json'};
const request=async(path,body)=>{
 const at=new Date().toISOString();const response=await fetch('http://127.0.0.1:3111/agentmemory/'+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
 return {at,status:response.status,body:await response.json()};
};
for(let n=0;n<count;n++) {
 const start=Date.now();
 const health=await request('health');const livez=await request('livez');
 const observe=await request('observe',{hookType:'PostToolUse',sessionId:'health-repro-'+variant,project:'health-repro',cwd:'/synthetic',timestamp:new Date().toISOString(),data:{tool_name:'Read',tool_input:{file_path:'/synthetic/sample-'+n+'.txt'},tool_response:'Synthetic health workload sample '+n+'; no user data.'}});
 const diagnostics=JSON.parse(readFileSync('/tmp/health-repro-diagnostics.json','utf8'));
 console.log(JSON.stringify({variant,n,deploymentId:process.env.RAILWAY_DEPLOYMENT_ID,health,livez,observe,diagnostics}));
 if(n<count-1)await new Promise(r=>setTimeout(r,Math.max(0,30000-(Date.now()-start))));
}
```

After verifying the exact deployment is successful, run inside that container:

```sh
node - <<'NODE'
const fs = require("node:fs");
fs.writeFileSync("/tmp/health-repro-control.next", JSON.stringify({ heapMiB: 640, nativeMiB: 64, siblingMiB: 64 }));
fs.renameSync("/tmp/health-repro-control.next", "/tmp/health-repro-control.json");
NODE
sleep 65
node /tmp/health-repro-sample.mjs candidate 31 > /tmp/health-samples.jsonl
node - <<'NODE'
const fs = require("node:fs");
fs.writeFileSync("/tmp/health-repro-control.next", "{}");
fs.renameSync("/tmp/health-repro-control.next", "/tmp/health-repro-control.json");
NODE
```

Changing the label only identifies the output; select baseline/current/candidate by deploying the corresponding source artifact. Archive the JSONL before stopping the disposable container. The baseline-only source change is `const heapCeiling = snapshot.memory.heapTotal;` in the recorded old `evaluateHealth` implementation; do not apply it to the candidate implementation.

### Controlled checks (reproducible pseudocode)

The following sequence describes the transition samplers. Use the same request helper and diagnostics as above; poll every two seconds while the application collector runs every 30 seconds. Every poll includes one health response, one liveness response and one synthetic observation write.

```text
Redeploy identical candidate image with sandbox-only warning=3, critical=5.
Wait at least 70 seconds with control={} and verify healthy.
Record before sample.
Atomically set control={heapMiB:640,nativeMiB:64,siblingMiB:64}.
Record 48 entry polls, two seconds apart.
Atomically set control={heapMiB:0,nativeMiB:0,siblingMiB:0}; wait two seconds.
Force worker GC via inspector HeapProfiler.collectGarbage (helper below).
Record 48 recovery polls, two seconds apart.
Verify entry: entering(samples=1)/200, then critical/503 on next fresh snapshot.
Verify recovery: recovering(samples=1)/503, then healthy/200 on next fresh snapshot.
Verify repeated polls with identical uptimeSeconds never change transition state.

Starting healthy after removing bulk heap/native/sibling load:
Record before sample.
Write /tmp/health-repro-cache.bin using 512 writes of one touched 1 MiB buffer.
Record 48 file-cache polls, two seconds apart; include memory.stat.
Unlink only that test file.
Record 48 cache-recovery polls, two seconds apart.
Verify cgroup occupancy can independently enter/recover while heap stays healthy.
```

The file-cache sampler reads `memory.stat` directly for each poll, separately from the unchanged allocation module. Save this exact helper as `/tmp/cache-samples.mjs` and run `node /tmp/cache-samples.mjs` inside the disposable container after recovery:

```javascript
import {readFileSync,openSync,writeSync,closeSync,unlinkSync} from 'node:fs';
const secret=readFileSync('/data/.hmac','utf8').trim();
const headers={authorization:`Bearer ${secret}`,'content-type':'application/json'};
const request=async(path,body)=>{const at=new Date().toISOString();const response=await fetch('http://127.0.0.1:3111/agentmemory/'+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});return {at,status:response.status,body:await response.json()};};
const sample=async(phase,n)=>{const health=await request('health');const livez=await request('livez');const observe=await request('observe',{hookType:'PostToolUse',sessionId:'health-repro-cache',project:'health-repro',cwd:'/synthetic',timestamp:new Date().toISOString(),data:{tool_name:'Read',tool_input:{file_path:'/synthetic/cache-'+phase+'-'+n+'.txt'},tool_response:'Synthetic cache capacity sample'}});console.log(JSON.stringify({phase,n,deploymentId:process.env.RAILWAY_DEPLOYMENT_ID,health,livez,observe,diagnostics:JSON.parse(readFileSync('/tmp/health-repro-diagnostics.json','utf8')),memoryStat:readFileSync('/sys/fs/cgroup/memory.stat','utf8')}));};
await sample('before',0);
const fd=openSync('/tmp/health-repro-cache.bin','w');const buffer=Buffer.alloc(1024*1024,0x5a);
for(let n=0;n<512;n++)writeSync(fd,buffer);closeSync(fd);
for(let n=0;n<48;n++){await sample('file-cache',n);await new Promise(r=>setTimeout(r,2000));}
unlinkSync('/tmp/health-repro-cache.bin');
for(let n=0;n<48;n++){await sample('cache-recovery',n);await new Promise(r=>setTimeout(r,2000));}
```

The corrected GC helper runs only inside the disposable container. It opens the worker's loopback inspector, collects dead test allocations, records memory and closes the inspector. Save as `/tmp/force-gc.mjs`:

```javascript
import {readFileSync} from 'node:fs';
const pid=JSON.parse(readFileSync('/tmp/health-repro-diagnostics.json','utf8')).pid;
process.kill(pid,'SIGUSR1');
await new Promise(r=>setTimeout(r,1000));
const targets=await (await fetch('http://127.0.0.1:9229/json/list')).json();
const ws=new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
let id=0;
async function command(method,params={}){const requestId=++id;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Inspector timeout')),10000);function handle(e){const r=JSON.parse(e.data);if(r.id!==requestId)return;clearTimeout(timer);ws.removeEventListener('message',handle);if(r.error||r.result?.exceptionDetails)reject(new Error(JSON.stringify(r)));else resolve(r.result);}ws.addEventListener('message',handle);ws.send(JSON.stringify({id:requestId,method,params}));});}
await command('HeapProfiler.collectGarbage');
console.log(JSON.stringify({forcedGc:await command('Runtime.evaluate',{expression:'process.memoryUsage()',returnByValue:true})}));
await command('Runtime.evaluate',{expression:'setTimeout(() => process.getBuiltinModule("inspector").close(), 100)'});
ws.close();
```
