import { describe, expect, it } from 'vitest'
import { ATTACHMENT_SELECTION_SCHEMAS as schemas, isSelectionOffer, isSelectionRead, selectionPath } from './attachment-selection-callbacks'
import { NATIVE_ATTACHMENT_PICK_CODECS } from './native-attachment-pick-codecs'
const selected={selectionId:'61f07006-c85b-438e-83a7-497c77b0dcae',path:'/tmp/写真.txt',filename:'写真.txt',size:3},leaseId='ui_selection_fixture'
describe('finite native attachment selection boundary',()=>{
 it('keeps native selection receipt fields private and public picker arguments empty',()=>{
  expect(isSelectionOffer({leaseId,selections:[selected]})).toBe(true)
  const codec=NATIVE_ATTACHMENT_PICK_CODECS['attachments:pick'];expect(codec.encodeArguments([])).toEqual({});expect(codec.decodeResult([selected.path])).toEqual([selected.path])
  for(const value of [{taskId:'chosen'}, {path:'/etc/passwd'}, {selectionId:selected.selectionId}])expect(()=>codec.decodeArguments(value as never)).toThrow()
  expect(codec.validateWireResult({defined:true,value:[selected.path],selectionId:selected.selectionId})).toBe(false)
  expect(codec.validateResult(Array(17).fill('/tmp/selection'))).toBe(false);expect(codec.validateResult([selected.path,selected.path])).toBe(false)
 })
 it('refuses aliases, traversal, malformed filenames, oversized files and forged scopes',()=>{
  for(const path of ['/tmp/../private','/tmp//private','relative','/tmp/./private','/tmp/private/','/tmp/a\0b','/tmp/\ud800'])expect(selectionPath(path)).toBe(false)
  for(const value of [{...selected,root:'/'},{...selected,size:67108865},{...selected,filename:'../private'},{...selected,path:'/tmp/other'}])expect(isSelectionOffer({leaseId,selections:[value]})).toBe(false)
  expect(isSelectionOffer({leaseId,selections:[selected,selected]})).toBe(false)
 })
 it('bounds exact sequential read payloads and result envelopes before decoding',()=>{
  const request={selectionId:selected.selectionId,leaseId,offset:0,length:3};expect(isSelectionRead(request)).toBe(true)
  for(const value of [{...request,length:65537},{...request,offset:-1},{...request,length:0},{...request,path:'/etc/passwd'},{...request,leaseId:'../forged'}])expect(isSelectionRead(value)).toBe(false)
  expect(schemas['host.attachment.selection.read'].validateResult({data:'YWJj'})).toBe(true)
  for(const data of ['data:text/plain;base64,YWJj','YWJj\n','A'.repeat(87388)])expect(schemas['host.attachment.selection.read'].validateResult({data})).toBe(false)
  expect(schemas['host.attachment.selection.retire'].validateResult({retired:true})).toBe(true);expect(schemas['host.attachment.selection.retire'].validateResult({retired:true,path:'/private'})).toBe(false)
 })
})
