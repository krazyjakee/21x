import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentSelectionOwner } from './attachment-selection-owner'
import type { AttachmentSelectionBridge } from '../shared/attachment-selection-callbacks'
const id='61f07006-c85b-438e-83a7-497c77b0dcae', other='71f07006-c85b-438e-83a7-497c77b0dcae', lease='ui_selection_fixture'
const selected={selectionId:id,path:'/tmp/selected.txt',filename:'selected.txt',size:3}
const owners:AttachmentSelectionOwner[]=[]
function make(bridge?:Partial<AttachmentSelectionBridge>){const native={finish:vi.fn(async()=>({verified:true as const})),read:vi.fn(async()=>({data:'YWJj'})),retire:vi.fn(async()=>({retired:true as const})),...bridge};const owner=new AttachmentSelectionOwner(native,()=>{});owners.push(owner);return{owner,native}}
function held(){let release!:()=>void;const promise=new Promise<void>(yes=>{release=yes});return{promise,release}}
afterEach(async()=>{for(const owner of owners.splice(0))await owner.close()})
describe('private selection ownership',()=>{
 it('requires a native offer and physical document match; claims once before any raw read',async()=>{
  const{owner,native}=make();expect(()=>owner.claim(selected.path,lease,()=>{})).toThrow()
  expect(owner.offer({leaseId:lease,selections:[selected]})).toEqual({accepted:true})
  for(const path of ['/etc/passwd','/tmp/../selected.txt'])expect(()=>owner.claim(path,lease,()=>{})).toThrow()
  expect(()=>owner.claim(selected.path,'ui_other',()=>{})).toThrow()
  const entry=owner.claim(selected.path,lease,()=>{});expect(()=>owner.claim(selected.path,lease,()=>{})).toThrow();expect(native.read).not.toHaveBeenCalled()
  expect(await entry.read(0,3)).toEqual(Buffer.from('abc'));await expect(entry.read(0,3)).rejects.toThrow();await entry.close()
  expect(owner.offer({leaseId:lease,selections:[selected]})).toEqual({accepted:false});expect(native.read).toHaveBeenCalledTimes(1)
 })
 it('supersedes an unclaimed same-path selection, joins old cleanup and leaves a claimed selection untouched',async()=>{
  const{owner,native}=make();owner.offer({leaseId:lease,selections:[selected]})
  expect(owner.offer({leaseId:lease,selections:[{...selected,selectionId:other}]})).toEqual({accepted:true})
  const entry=owner.claim(selected.path,lease,()=>{});await entry.read(0,3)
  expect(native.read).toHaveBeenCalledWith({leaseId:lease,selectionId:other,offset:0,length:3})
  expect(owner.offer({leaseId:lease,selections:[{...selected,selectionId:'81f07006-c85b-438e-83a7-497c77b0dcae'}]})).toEqual({accepted:false})
  await entry.finish();await entry.close();await owner.close();expect(native.retire).toHaveBeenCalledTimes(2)
 })
 it('rejects duplicate/hostile offers atomically without accepting a subset',()=>{
  const{owner}=make();for(const value of [{leaseId:lease,selections:[selected,{...selected,selectionId:other}]},{leaseId:lease,selections:[selected,{...selected,selectionId:other,path:'/tmp/../evil'}]},{leaseId:lease,selections:[{...selected,size:67108865}]},{leaseId:lease,selections:[{...selected,filename:'../selected.txt'}]}])expect(owner.offer(value)).toEqual({accepted:false})
  expect(owner.offer({leaseId:lease,selections:[selected]})).toEqual({accepted:true})
 })
 it('rechecks captured scope after an ignored raw read and joins it before retirement',async()=>{
  const gate=held(),entered=held();let allowed=true
  const{owner,native}=make({read:vi.fn(async()=>{entered.release();await gate.promise;return{data:'YWJj'}})})
  owner.offer({leaseId:lease,selections:[selected]});const entry=owner.claim(selected.path,lease,()=>{if(!allowed)throw Error('withdrawn')})
  const pending=entry.read(0,3).catch(e=>e);await entered.promise;allowed=false;const close=entry.close();expect(native.retire).not.toHaveBeenCalled()
  gate.release();expect(await pending).toBeInstanceOf(Error);await close;expect(native.retire).toHaveBeenCalledTimes(1)
 })
 it('keeps failed retirement for explicit retry without reopening or rereading',async()=>{
  let refuse=true;const{owner,native}=make({retire:vi.fn(async()=>{if(refuse)throw Error('refused');return{retired:true as const}})})
  owner.offer({leaseId:lease,selections:[selected]});const entry=owner.claim(selected.path,lease,()=>{})
  await expect(entry.close()).rejects.toThrow('refused');expect(()=>owner.claim(selected.path,lease,()=>{})).toThrow()
  refuse=false;await owner.close();expect(native.read).not.toHaveBeenCalled();expect(native.retire).toHaveBeenCalledTimes(2)
 })
 it('rejects malformed/noncanonical chunks and concurrent reads without replay',async()=>{
  const gate=held(),entered=held();const{owner,native}=make({read:vi.fn(async()=>{entered.release();await gate.promise;return{data:'YWJj\n'}})})
  owner.offer({leaseId:lease,selections:[selected]});const entry=owner.claim(selected.path,lease,()=>{}),pending=entry.read(0,3).catch(e=>e)
  await entered.promise;await expect(entry.read(0,3)).rejects.toThrow();gate.release();expect(await pending).toBeInstanceOf(Error)
  await expect(entry.read(0,3)).rejects.toThrow();expect(native.read).toHaveBeenCalledTimes(1)
 })
 it('fences shutdown immediately and keeps held raw receipts through a close deadline',async()=>{
  const gate=held(),entered=held();const{owner,native}=make({read:vi.fn(async()=>{entered.release();await gate.promise;return{data:'YWJj'}})})
  owner.offer({leaseId:lease,selections:[selected]});const entry=owner.claim(selected.path,lease,()=>{}),pending=entry.read(0,3).catch(e=>e)
  await entered.promise;await expect(owner.close(5)).rejects.toMatchObject({code:'TIMEOUT'});expect(owner.offer({leaseId:lease,selections:[{...selected,selectionId:other}]})).toEqual({accepted:false});expect(native.retire).not.toHaveBeenCalled()
  gate.release();expect(await pending).toBeInstanceOf(Error);await owner.close();expect(native.retire).toHaveBeenCalledTimes(1)
 })
})
