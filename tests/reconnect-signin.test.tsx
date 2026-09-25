import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Session } from '@supabase/supabase-js'
import { ReconnectSignIn } from '../src/features/dashboard/reconnect-signin.tsx'
import { postRepair, repairTarget, type RepairDevice } from '../src/features/dashboard/repair-signins-state.ts'
import { queryClient } from '../src/lib/query-client.ts'
const session = { access_token: 'fixture-token', user: { id: 'fixture-user' } } as Session
const device: RepairDevice = { id:'machine-1', label:'Fixture Mac', machineName:null, expired:['a@example.test'], missing:[], link:null, pending:null, lastResult:null, lastSeenAt:'2026-09-24T10:00:00Z', reportedAt:null }
const render = (next = device) => renderToStaticMarkup(createElement(ReconnectSignIn, { devices:[next], email:'a@example.test', session }))
test('an expired row offers sign-in, then its pending link, and disappears after reconnection',()=>{
 assert.match(render(),/>Sign in</)
 assert.match(render({...device,pending:{emails:['a@example.test'],requestedAt:device.lastSeenAt}}),/Opening sign-in/)
 const pending={emails:['a@example.test'],requestedAt:device.lastSeenAt}
 assert.match(render({...device,pending,link:{email:'a@example.test',at:device.lastSeenAt,url:'https://auth.openai.com/oauth/authorize?fixture=true'}}),/href="https:\/\/auth.openai.com/)
 assert.doesNotMatch(render({...device,pending,link:{email:'other@example.test',at:device.lastSeenAt,url:'https://auth.openai.com/oauth/authorize?fixture=true'}}),/href=/)
 assert.equal(render({...device,expired:[]}), '')
 assert.match(render({...device,pending:{emails:['other@example.test'],requestedAt:device.lastSeenAt}}),/disabled=""/)
})
test('selects only the expired holder, preferring an existing request then the latest online machine',()=>{
 const newer={...device,id:'machine-2',lastSeenAt:'2026-09-24T11:00:00Z'}
 assert.equal(repairTarget([device,newer],'A@example.test')?.id,'machine-2')
 assert.equal(repairTarget([{...device,pending:{emails:['a@example.test'],requestedAt:device.lastSeenAt}},newer],'a@example.test')?.id,'machine-1')
 assert.equal(repairTarget([device],'other@example.test'),null)
})
test('posts only the selected account and immediately exposes returned progress to every row',async()=>{
 const original=globalThis.fetch
 const devices=[{...device,pending:{emails:['a@example.test'],requestedAt:device.lastSeenAt}}]
 try {
  globalThis.fetch=async(url,options)=>{
   assert.equal(url,'/api/login/repair')
   assert.equal(options?.method,'POST')
   assert.deepEqual(JSON.parse(String(options?.body)),{deviceId:'machine-1',emails:['a@example.test']})
   return new Response(JSON.stringify({devices,requested:1}))
  }
  await postRepair(session,{deviceId:device.id,emails:['a@example.test']})
  assert.deepEqual(queryClient.getQueryData(['repair-signins',session.user.id]),devices)
  globalThis.fetch=async()=>new Response(JSON.stringify({error:'Machine unavailable'}),{status:409})
  await assert.rejects(postRepair(session,{}),/Machine unavailable/)
 }finally{globalThis.fetch=original;queryClient.clear()}
})

test('the 12-hour cutoff offers reconnect for stale Codex and Claude rows without an expiry report',async()=>{
 const {isSignInStale}=await import('../src/features/dashboard/repair-signins-state.ts')
 const now=Date.parse('2026-09-25T00:00:00Z')
 assert.equal(isSignInStale('2026-09-24T12:00:00Z',now),false)
 assert.equal(isSignInStale('2026-09-24T11:59:59.999Z',now),true)
 assert.equal(isSignInStale(null,now),false)
 assert.equal(isSignInStale('invalid',now),false)
 for(const provider of ['codex','claude'] as const){
  const html=renderToStaticMarkup(createElement(ReconnectSignIn,{devices:[{...device,expired:[]}],email:'a@example.test',session,provider,lastUpdate:'2020-01-01T00:00:00Z'}))
  assert.match(html,/Update stale sign-in/)
  assert.match(html,/Last update is over 12 hours old/)
 }
 const html=renderToStaticMarkup(createElement(ReconnectSignIn,{devices:[{...device,pending:{provider:'claude',emails:['a@example.test'],requestedAt:device.lastSeenAt},link:{provider:'claude',email:'a@example.test',at:device.lastSeenAt,url:'https://claude.ai/oauth/authorize?client_id=fixture'}}],email:'a@example.test',session,provider:'codex'}))
 assert.doesNotMatch(html,/href=/,'same email on another provider never gets its authorization link')
})
