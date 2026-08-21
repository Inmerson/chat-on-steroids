import struct,zlib,binascii,pathlib
w=h=8192
raw=bytearray((w+1)*h)  # filter byte 0 + 8192 grayscale pixels per row, all zero
compressed=zlib.compress(raw,9)
def chunk(kind,data):
    return struct.pack('>I',len(data))+kind+data+struct.pack('>I',binascii.crc32(kind+data)&0xffffffff)
png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,0,0,0,0))+chunk(b'IDAT',compressed)+chunk(b'IEND',b'')
out=pathlib.Path('bughunt-2026-08-20/png-inflate-probe.png')
out.write_bytes(png)
print({'width':w,'height':h,'raw_bytes':len(raw),'png_bytes':len(png),'ratio':round(len(raw)/len(png),1)})
