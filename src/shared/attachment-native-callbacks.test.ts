import { describe, expect, it } from 'vitest'
import { isAttachmentPathReceipt, isPrivateAttachmentOpen, ATTACHMENT_NATIVE_CALLBACK_SCHEMAS, type AttachmentPathReceipt } from './attachment-native-callbacks'
function receipt(): AttachmentPathReceipt {
  const attachmentRoot='/protected/attachments',taskId='task_fixture',attachmentId='61f07006-c85b-438e-83a7-497c77b0dcae',filename='報告.txt',taskPath=`${attachmentRoot}/${taskId}`,path=`${taskPath}/${attachmentId}-${filename}`
  return {version:1,taskId,attachmentId,filename,attachmentRoot,path,root:{path:attachmentRoot,dev:'1',ino:'100',kind:'directory',size:'4096',nlink:'2'},ancestors:[{path:taskPath,dev:'1',ino:'101',kind:'directory',size:'4096',nlink:'2'}],target:{path,dev:'1',ino:'102',kind:'file',size:String(64*1024*1024),nlink:'1'}}
}
describe('browser-pure exact attachment/native identities',()=>{
  it('validates literal attachment roots and uint64 physical identities without workspace authority',()=>{
    expect(isAttachmentPathReceipt(receipt())).toBe(true)
    const upper=receipt();upper.target.dev='18446744073709551615';expect(isAttachmentPathReceipt(upper)).toBe(true)
    for(const value of [
      {...receipt(),workspaceRoot:'/foreign/workspace'}, {...receipt(),attachmentRoot:'/protected/attachments/..'},
      {...receipt(),taskId:'../foreign'}, {...receipt(),attachmentId:'00000000-0000-0000-8000-000000000001'},
      {...receipt(),filename:'../report.txt'}, {...receipt(),filename:'bad\0.txt'}, {...receipt(),filename:'\ud800'},
      {...receipt(),path:receipt().path+'-alias'}, {...receipt(),ancestors:[]},
      {...receipt(),ancestors:[...receipt().ancestors,...receipt().ancestors]},
      {...receipt(),ancestors:[{...receipt().ancestors[0],path:'/foreign/task_fixture'}]},
      {...receipt(),root:{...receipt().root,kind:'file'}}, {...receipt(),target:{...receipt().target,kind:'directory'}},
      {...receipt(),target:{...receipt().target,nlink:'2'}}, {...receipt(),target:{...receipt().target,size:String(64*1024*1024+1)}},
      {...receipt(),target:{...receipt().target,ino:'01'}}, {...receipt(),target:{...receipt().target,dev:'18446744073709551616'}},
      {...receipt(),target:{...receipt().target,path:'/foreign/file'}}, {...receipt(),root:{...receipt().root,mtime:'private'}}
    ])expect(isAttachmentPathReceipt(value)).toBe(false)
  })
  it('requires an exact current native document stamp outside the owner-produced receipt',()=>{
    const callback=ATTACHMENT_NATIVE_CALLBACK_SCHEMAS['host.attachment.open'],value=receipt()
    expect(callback.validatePayload({receipt:value,leaseId:'document:one'})).toBe(true)
    expect(callback.validateResult({})).toBe(true)
    for(const payload of [{receipt:value},{receipt:value,leaseId:'forged whitespace'},{receipt:value,leaseId:'document:one',authority:'*'},{receipt:{...value,leaseId:'document:one'},leaseId:'document:one'}])expect(callback.validatePayload(payload)).toBe(false)
    expect(callback.validateResult({success:true})).toBe(false);expect(callback.validateResult(undefined)).toBe(false)
    expect(isPrivateAttachmentOpen({taskId:value.taskId,attachmentId:value.attachmentId,leaseId:'document:one'})).toBe(true)
    for(const payload of [{taskId:value.taskId,attachmentId:value.attachmentId},{taskId:value.taskId,attachmentId:value.attachmentId,leaseId:'document:one',path:value.path},{taskId:'../foreign',attachmentId:value.attachmentId,leaseId:'document:one'}])expect(isPrivateAttachmentOpen(payload)).toBe(false)
  })
})
