import { describe, expect, it } from 'vitest'
import { attachmentRaster, ATTACHMENT_RASTER_LIMITS } from './attachment-raster'
import { isAttachmentImage, ATTACHMENT_IMAGE_BYTES } from './attachment-image'
import { NATIVE_ATTACHMENT_IMAGE_CODECS } from './attachment-image-codecs'
import type { JsonValue } from './service-protocol'
import type { ChatImageMimeType } from './chat-images'
const fixtures = {PNG: 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFUlEQVR4nGMUVDJmYGBgYGBgYoABAAdGAGpAmhbFAAAAAElFTkSuQmCC', JPEG: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDx6iiiuo5j/9k=', GIF: 'R0lGODdhAwACAIEAABEiMwAAAAAAAAAAACwAAAAAAwACAAAIBgABCBwYEAA7', WEBP: 'UklGRjAAAABXRUJQVlA4ICQAAABwAQCdASoDAAIAAUAmJYwCdAFAAAD++xnLAkrVm6cszhXnwAA='} as const
const mime = { PNG: 'image/png', JPEG: 'image/jpeg', GIF: 'image/gif', WEBP: 'image/webp' } as const
const codec = NATIVE_ATTACHMENT_IMAGE_CODECS['attachments:readImage']
const bytes = (kind: keyof typeof fixtures) => Uint8Array.from(atob(fixtures[kind]), c => c.charCodeAt(0))
const image = (data: Uint8Array, mimeType: ChatImageMimeType) => ({ mimeType, data: btoa(String.fromCharCode(...data)) })
describe('saved attachment raster admission', () => {
  it.each(['PNG','JPEG','GIF','WEBP'] as const)('admits a complete controlled %s container and round-trips the exact finite wire bytes', kind => {
    const input = { mimeType: mime[kind], data: fixtures[kind] }
    expect(attachmentRaster(bytes(kind), input.mimeType)).toEqual({ width: 3, height: 2, frames: 1 })
    expect(isAttachmentImage(input)).toBe(true)
    expect(codec.validateWireResult(codec.encodeResult(input))).toBe(true)
    expect(codec.decodeResult(input)).toEqual(input)
    expect(Object.isFrozen(codec.decodeResult(input))).toBe(true)
    for (let length=0; length<bytes(kind).length; length++) expect(attachmentRaster(bytes(kind).subarray(0,length), input.mimeType)).toBeNull()
    expect(isAttachmentImage({ ...input, mimeType: kind==='PNG'?'image/gif':'image/png' })).toBe(false)
  })
  it('refuses oversize/zero canvas, expansion pixels and compressed PNG metadata/APNG before decoding', () => {
    const original = bytes('PNG')
    for (const [w,h] of [[0,1],[4097,1],[4096,4096],[1,4294967295]]) {
      const b=original.slice(),v=new DataView(b.buffer);v.setUint32(16,w);v.setUint32(20,h)
      expect(isAttachmentImage(image(b,'image/png'))).toBe(false)
    }
    for (const type of ['acTL','fcTL','fdAT','iCCP','zTXt','iTXt']) {
      const chunk=new Uint8Array(12);chunk.set([...type].map(c=>c.charCodeAt(0)),4)
      const b=new Uint8Array(original.length+12);b.set(original.subarray(0,33));b.set(chunk,33);b.set(original.subarray(33),45)
      expect(isAttachmentImage(image(b,'image/png'))).toBe(false)
    }
    const max = new Uint8Array(ATTACHMENT_IMAGE_BYTES+1)
    expect(attachmentRaster(max,'image/png')).toBeNull()
  })
  it('bounds every GIF canvas/frame, frame count and sub-block walk', () => {
    const b=bytes('GIF'), bomb=b.slice();new DataView(bomb.buffer).setUint16(6,4096,true);new DataView(bomb.buffer).setUint16(8,4096,true)
    expect(attachmentRaster(bomb,'image/gif')).toBeNull()
    const frame=b.subarray(b.indexOf(0x2c),b.length-1)
    const repeated=new Uint8Array(b.length+frame.length*32);repeated.set(b.subarray(0,b.length-1));for(let i=0;i<32;i++)repeated.set(frame,b.length-1+i*frame.length);repeated[repeated.length-1]=0x3b
    expect(attachmentRaster(repeated,'image/gif')).toBeNull()
    const outside=b.slice();new DataView(outside.buffer).setUint16(b.indexOf(0x2c)+1,3,true)
    expect(attachmentRaster(outside,'image/gif')).toBeNull()
    expect(ATTACHMENT_RASTER_LIMITS).toEqual({edge:4096,pixels:8388608,frames:32,chunks:4096})
  })
  it('rejects appended polyglots and JPEG redefinition/scans without an admitted frame', () => {
    for(const kind of Object.keys(fixtures) as Array<keyof typeof fixtures>) {
      const b=bytes(kind),append=new Uint8Array(b.length+1);append.set(b)
      expect(attachmentRaster(append,mime[kind])).toBeNull()
    }
    const b=bytes('JPEG'),sof=b.findIndex((v,i)=>v===255&&b[i+1]===0xc0)
    expect(sof).toBeGreaterThan(0)
    const oversized=b.slice();new DataView(oversized.buffer).setUint16(sof+7,4097)
    expect(attachmentRaster(oversized,'image/jpeg')).toBeNull()
    const hierarchical=b.slice();hierarchical[sof+1]=0xc1
    expect(attachmentRaster(hierarchical,'image/jpeg')).toBeNull()
    const redefine=new Uint8Array(b.length+6);redefine.set(b.subarray(0,-2));redefine.set([255,0xdc,0,4,0,2,255,0xd9],b.length-2)
    expect(attachmentRaster(redefine,'image/jpeg')).toBeNull()
  })
  it('rejects animated WebP, mismatched RIFF length and false dimension extension', () => {
    const b=bytes('WEBP'),bad=b.slice();new DataView(bad.buffer).setUint32(4,b.length,true)
    expect(attachmentRaster(bad,'image/webp')).toBeNull()
    const extended=new Uint8Array(b.length+18);extended.set(b.subarray(0,12));extended.set([86,80,56,88,10,0,0,0,2,0,0,0,2,0,0,1,0,0],12);extended.set(b.subarray(12),30);new DataView(extended.buffer).setUint32(4,extended.length-8,true)
    expect(attachmentRaster(extended,'image/webp')).toBeNull()
    extended[20]=0;extended[24]=3
    expect(attachmentRaster(extended,'image/webp')).toBeNull()
  })
  it('admits only exact IDs and canonical bounded raster results, never paths, URLs or extra authority', () => {
    const args: [string,string]=['task_fixture','00000000-0000-4000-8000-000000000001']
    expect(codec.decodeArguments(codec.encodeArguments(args))).toEqual(args)
    for (const payload of [{taskId:'../escape',attachmentId:args[1]},{taskId:args[0],attachmentId:'file:///etc/passwd'},{taskId:args[0],attachmentId:args[1],leaseId:'forged'}] as JsonValue[]) expect(()=>codec.decodeArguments(payload)).toThrow()
    const valid={mimeType:'image/png' as const,data:fixtures.PNG}
    for(const value of [{...valid,path:'/etc/passwd'},{...valid,mimeType:'image/svg+xml'},{...valid,data:valid.data+'\n'},{...valid,data:'A'.repeat(699052)},{...valid,data:valid.data.slice(0,-2)+'B='},null,undefined]) {
      expect(isAttachmentImage(value)).toBe(false);expect(()=>codec.encodeResult(value)).toThrow()
    }
    expect(codec.validateWireResult({defined:false})).toBe(false)
    expect(codec.validateWireResult({defined:true,value:valid,leaseId:'forged'})).toBe(false)
  })
})
