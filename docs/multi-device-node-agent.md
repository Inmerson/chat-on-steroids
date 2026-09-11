# Node Agent kurulumu

Node Agent, `Chat-On-Steroids-Setup-x64.exe` ana kurulum paketinin içinde gelir. Kurulumdan sonra `resources\\node-agent\\Chat-On-Steroids-Node-Agent.exe` yolunda hazırdır; ayrıca ikinci bir kurulum gerekmez. Coordinator bir yönetim ve uzaktan yönlendirme noktasıdır; cihazın yerel agent'ı Coordinator kapalıyken de çalışmaya devam eder.

Uygulamadaki cihaz rolü ve IP alanları yazarken otomatik kaydedilir. Bir cihaz `Coordinator` seçildikten sonra uygulama yeniden başlatılır; `Node` alanındaki IP ise bağlanacağı Coordinator'ın Tailscale IP'sidir.

1. Uzak yönetim isteniyorsa ikinci bilgisayarda Tailscale kurulu ve Coordinator bilgisayarına erişebiliyor olmalı. Yalnızca bağımsız kullanımda `coordinator_url` ve `pairing_code` alanlarını tamamen çıkarın.
2. Aşağıdaki alanları içeren yerel bir `node-agent.json` oluşturun. `listen_host` yalnızca ikinci bilgisayarın Tailscale IPv4 adresi olmalıdır; wildcard ve loopback adresleri reddedilir.
3. Coordinator arayüzünden üretilen tek kullanımlık pairing kodunu `pairing_code` alanına yazın.
4. Agent’ı `Chat-On-Steroids-Node-Agent.exe --config C:\COS-MultiDevice\node-agent.json` ile başlatın.

```json
{
  "coordinator_url": "ws://100.64.0.10:8788",
  "friendly_name": "Ibrahim Laptop",
  "state_dir": "C:\\COS-MultiDevice\\node-state",
  "capabilities": ["filesystem.read", "filesystem.write", "terminal.exec"],
  "approved_roots": ["C:\\COS-MultiDevice\\workspace"],
  "pairing_code": "COS-ONE-TIME-CODE",
  "listen_host": "100.64.0.11",
  "listen_port": 8788
}
```

Pairing kodu başarılı eşleştirmeden sonra config dosyasından atomik olarak silinir. Agent yalnızca `approved_roots` içindeki dosya işlemlerini kabul eder; terminal çalıştırma için çalışma klasörü de bu köklerden biri olmalıdır. Etkileşimli TTY ve `write_stdin` uzaktan kullanım için kapalıdır.

Pairing tamamlandığında Agent kendi durum klasöründe yalnızca yerel olarak saklanan bir resume secret alır. Coordinator bunun düz metnini saklamaz; sadece doğrulama özeti tutulur. Agent yeniden başladığında aynı cihaz kimliğiyle otomatik bağlanır ve yeni bir pairing kodu istemez.

Bu paket güvenli agent çalışma dilimini ve Coordinator yönlendirmesini kapsar. Gerçek iki ayrı bilgisayar/Tailscale smoke testi, ağ kopması ve cihaz iptali akışları tamamlanmadan üretim çoklu cihaz özelliği tamamlanmış sayılmaz.

## Bağımsız çalışma davranışı

- Her agent ilk açılışta kendi `state_dir` altında kalıcı cihaz kimliği ve yalnızca yerel agent tarafından kullanılan erişim belirteci üretir.
- Coordinator kapalıysa agent dinlemeyi, onaylı köklerde dosya işlemlerini ve yetkili yerel istekleri sürdürür.
- Pairing kodu yalnızca Coordinator'a ilk katılım içindir; silinmesi cihazın yerel çalışma yeteneğini kaldırmaz.
- Agent ve Coordinator arasındaki geçici ağ kopmalarında Agent, sabit aralıkla aynı kalıcı cihaz kimliğiyle yeniden bağlanmayı dener. Resume secret geçersizse bağlantı reddedilir; yeni pairing kodu gerekir.
