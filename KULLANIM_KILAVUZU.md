# Chat On Steroids — Hızlı Başlangıç ve Kullanım Kılavuzu

Bu belge, **Chat On Steroids** uygulamasını yerel ortamınızda nasıl çalıştıracağınızı, Chrome uzantısını nasıl yükleyeceğinizi ve ChatGPT ile nasıl entegre edeceğinizi adım adım açıklar.

---

## 🚀 1. Uygulamayı Başlatma

### Geliştirici Modunda Çalıştırma (Önerilen)
Proje kök dizininde yer alan `start-dev.bat` dosyasına çift tıklayabilir veya terminalden şu komutu çalıştırabilirsiniz:

```powershell
npm run dev
```

Bu komut ile:
- Electron uygulaması açılacaktır.
- Sistem tepsisinde (tray) simge yerleşecektir.
- Yerel MCP sunucusu ve loopback bridge (127.0.0.1) aktif hale gelecektir.

---

## 🧩 2. Chrome Uzantısını Yükleme

ChatGPT web arayüzü ile oturum senkronizasyonu ve gelişmiş araç görünümü için:

1. **Google Chrome** tarayıcısını açın ve adres çubuğuna `chrome://extensions/` yazın.
2. Sağ üst köşedeki **Geliştirici Modu (Developer Mode)** anahtarını açın.
3. Sol üstte beliren **Paketlenmemiş öğe yükle (Load unpacked)** butonuna tıklayın.
4. Proje içindeki `extension` klasörünü seçin:
   - Yol: `...\chat-on-steroids\extension`
5. Eklenti yüklendiğinde araç çubuğuna eklenecek ve uygulama açıkken otomatik eşleşecektir.

---

## 🔗 3. ChatGPT ile Bağlantı Kurma

ChatGPT'de **Developer Mode** ve **Custom MCP Apps** özelliği üzerinden iki farklı tünelleme yöntemi kullanabilirsiniz:

### Yöntem A: Cloudflare Quick Tunnel (En Kolay)
1. Chat On Steroids uygulamasının arayüzünden **Connect** butonuna basın.
2. Uygulamanın ürettiği gizli HTTPS URL'sini kopyalayın.
3. ChatGPT web arayüzünde (Developer Mode -> Custom Apps) yeni bir MCP sunucusu olarak bu URL'yi yapıştırın.

### Yöntem B: OpenAI Secure MCP Tunnel
1. [OpenAI Platform -> Tunnels](https://platform.openai.com/settings/organization/tunnels) adresinden bir tünel oluşturun.
2. Tünel ID'sini ve sınırlı yetkiye sahip API anahtarını uygulamadaki Setup paneline girin.
3. ChatGPT'de Custom App eklerken bu tüneli seçin.

---

## 🛡️ 4. İzinler ve Güvenlik Ayarları

* **Approved Roots (Onaylı Klasörler):** Modelin erişmesine izin vermek istediğiniz proje klasörlerini Home ekranından ekleyin.
* **Read-Only Switch:** İhtiyaç duyduğunuz anda tüm dosya yazma, terminal ve masaüstü kontrol yetkilerini tek bir tıkla dondurabilirsiniz.
* **Computer Use:** Ekran görüntüsü ve fare/klavye kontrolü için Desktop surface iznini isteğe bağlı olarak açıp kapatabilirsiniz.
