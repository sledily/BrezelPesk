import { runStorageScenario } from './storage-scenarios.mjs';

const results=[];
for(const playerCount of [2,4]) for(const busy of [false,true]) {
  const {result}=await runStorageScenario({playerCount,busy});
  results.push(result);
  process.stderr.write(`Measured ${playerCount}-player ${result.workload}\n`);
}
process.stdout.write(JSON.stringify({
  methodology:'20 full engine Years, seeded synthetic workloads through the room service. Not a worst-case bound or a quota guarantee; combat, future V2 state and provider physical overhead require separate coverage.',
  results,
},null,2)+'\n');
