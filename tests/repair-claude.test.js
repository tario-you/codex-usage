import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { claudeSignInUrl,repairClaudeLogin } from '../bin/lib/repair-claude.js'

test('Claude authorization links cannot point at a different provider or a lookalike host',()=>{
 assert.equal(claudeSignInUrl('https://claude.ai.evil.test/oauth/authorize?client_id=x'),null)
 assert.equal(claudeSignInUrl('https://auth.openai.com/oauth/authorize?client_id=x'),null)
 assert.equal(claudeSignInUrl('https://claude.ai/login'),null)
 assert.equal(claudeSignInUrl('Open https://claude.ai/oauth/authorize?client_id=x\n'),'https://claude.ai/oauth/authorize?client_id=x')
})
for(const outcome of ['signed-in','mismatch','failed']){
 test(`isolated Claude reconnect reports ${outcome} from saved account evidence`,async t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'claude-repair-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const helper=path.join(dir,'helper.js'),storePath=path.join(dir,'accounts.json');writeFileSync(helper,'// fixture')
  const links=[],now=Date.now()
  const spawnChild=(bin,args,options)=>{
   assert.equal(bin,process.execPath);assert.deepEqual(args,[helper,'--add','a@example.test']);assert.deepEqual(options.stdio,['ignore','pipe','pipe'])
   const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter()
   queueMicrotask(()=>{
    child.stdout.emit('data','https://claude.ai/oauth/author')
    child.stdout.emit('data','ize?client_id=fixture\n')
    writeFileSync(storePath,JSON.stringify({accounts:[{email:outcome==='mismatch'?'wrong@example.test':'a@example.test',updated_at:new Date(now+1).toISOString(),oauth:{accessToken:'fixture'}}]}))
    child.emit('close',outcome==='failed'?1:0)
   });return child
  }
  const result=repairClaudeLogin('a@example.test',{helper,storePath,spawnChild,now:()=>now,onLink:async(...args)=>links.push(args)})
  if(outcome==='failed')await assert.rejects(result,/did not complete/)
  else assert.equal((await result).outcome,outcome)
  assert.deepEqual(links,[['a@example.test','https://claude.ai/oauth/authorize?client_id=fixture','claude']])
 })
}
