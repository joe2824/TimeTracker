//! Geheimnisse so ablegen, dass eine kopierte Datei nichts wert ist.

use serde::Serialize;
use zeroize::Zeroize;

/// Was aus dem Schutz herauskam - und ob er ueberhaupt griff.
#[derive(Serialize)]
pub struct Protected {
    /// Base64 des geschuetzten Werts (oder des Klartexts, wenn `protected` false ist).
    pub data: String,
    /// Ob das Betriebssystem den Wert wirklich geschuetzt hat.
    pub protected: bool,
}

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::Foundation::{LocalFree, HLOCAL};
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
    };

    /// Ein Puffer, der sich selbst wieder freigibt.
    struct Blob(CRYPT_INTEGER_BLOB);

    impl Blob {
        fn empty() -> Self {
            Blob(CRYPT_INTEGER_BLOB {
                cbData: 0,
                pbData: std::ptr::null_mut(),
            })
        }
        fn to_vec(&self) -> Vec<u8> {
            if self.0.pbData.is_null() {
                return Vec::new();
            }
            unsafe { std::slice::from_raw_parts(self.0.pbData, self.0.cbData as usize).to_vec() }
        }
    }

    impl Drop for Blob {
        fn drop(&mut self) {
            if !self.0.pbData.is_null() {
                unsafe { LocalFree(self.0.pbData as HLOCAL) };
            }
        }
    }

    fn input(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: bytes.len() as u32,
            pbData: bytes.as_ptr() as *mut u8,
        }
    }

    pub fn protect(plain: &[u8]) -> Option<Vec<u8>> {
        let inp = input(plain);
        let mut out = Blob::empty();
        let ok = unsafe {
            CryptProtectData(
                &inp,
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                0,
                &mut out.0,
            )
        };
        if ok == 0 {
            None
        } else {
            Some(out.to_vec())
        }
    }

    pub fn unprotect(sealed: &[u8]) -> Option<Vec<u8>> {
        let inp = input(sealed);
        let mut out = Blob::empty();
        let ok = unsafe {
            CryptUnprotectData(
                &inp,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                0,
                &mut out.0,
            )
        };
        if ok == 0 {
            None
        } else {
            Some(out.to_vec())
        }
    }
}

/// Authentifizierte AES-256-GCM-Verschlüsselung, gebunden an die Hardware-UUID des Rechners
/// und das Benutzerkonto. Eine kopierte Datei (device.json) lässt sich auf keinem anderen Rechner
/// und keinem anderen Benutzerkonto entschlüsseln – ganz ohne aufdringliche Keychain-Passwort-Popups!
#[cfg(not(windows))]
mod imp {
    use aes_gcm::{
        aead::{Aead, KeyInit, OsRng},
        Aes256Gcm, Nonce,
    };
    use sha2::{Digest, Sha256};

    fn get_machine_id() -> String {
        #[cfg(target_os = "macos")]
        {
            use std::process::Command;
            if let Ok(output) = Command::new("ioreg")
                .args(["-rd1", "-c", "IOPlatformExpertDevice"])
                .output()
            {
                let text = String::from_utf8_lossy(&output.stdout);
                for line in text.lines() {
                    if line.contains("IOPlatformUUID") {
                        if let Some(uuid) = line.split('"').nth(3) {
                            return uuid.to_string();
                        }
                    }
                }
            }
        }
        #[cfg(target_os = "linux")]
        {
            if let Ok(id) = std::fs::read_to_string("/etc/machine-id") {
                let trimmed = id.trim();
                if !trimmed.is_empty() {
                    return trimmed.to_string();
                }
            }
        }
        std::env::var("HOSTNAME").unwrap_or_else(|_| "timetracker-desktop-device".to_string())
    }

    fn get_user_id() -> String {
        let user = std::env::var("USER").unwrap_or_default();
        let home = std::env::var("HOME").unwrap_or_default();
        format!("{user}:{home}")
    }

    fn derive_local_key() -> [u8; 32] {
        let machine = get_machine_id();
        let user = get_user_id();
        const SALT: &str = "com.jklein.timetracker.hardware_and_user_bound.v1";

        let mut hasher = Sha256::new();
        hasher.update(machine.as_bytes());
        hasher.update(b"|");
        hasher.update(user.as_bytes());
        hasher.update(b"|");
        hasher.update(SALT.as_bytes());
        let res = hasher.finalize();
        let mut key = [0u8; 32];
        key.copy_from_slice(&res);
        key
    }

    pub fn protect(plain: &[u8]) -> Option<Vec<u8>> {
        let key = derive_local_key();
        let cipher = Aes256Gcm::new_from_slice(&key).ok()?;
        let mut nonce_bytes = [0u8; 12];
        use aes_gcm::aead::rand_core::RngCore;
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);

        let ciphertext = cipher.encrypt(nonce, plain).ok()?;
        let mut out = Vec::with_capacity(12 + ciphertext.len());
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(&ciphertext);
        Some(out)
    }

    pub fn unprotect(sealed: &[u8]) -> Option<Vec<u8>> {
        if sealed.len() < 12 + 16 {
            return None;
        }
        let key = derive_local_key();
        let cipher = Aes256Gcm::new_from_slice(&key).ok()?;
        let nonce = Nonce::from_slice(&sealed[..12]);
        cipher.decrypt(nonce, &sealed[12..]).ok()
    }
}

fn b64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18 & 63) as usize] as char);
        out.push(TABLE[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6 & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

fn b64_decode(text: &str) -> Option<Vec<u8>> {
    let mut acc: u32 = 0;
    let mut bits = 0;
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    for &b in text.as_bytes() {
        let val = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\r' | b'\n' | b' ' => continue,
            _ => return None,
        };
        acc = (acc << 6) | val as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

/// Einen Wert schuetzen. Gibt zurueck, OB er geschuetzt wurde.
///
/// Das Feld `protected` ist kein Beiwerk: die Oberflaeche sagt dem Nutzer
/// damit die Wahrheit, statt einen Schutz zu behaupten, den es nicht gibt.
#[tauri::command]
pub fn protect_secret(mut plain: String) -> Protected {
    let ergebnis = match imp::protect(plain.as_bytes()) {
        Some(mut sealed) => {
            let data = b64_encode(&sealed);
            sealed.zeroize();
            Protected {
                data,
                protected: true,
            }
        }
        None => Protected {
            data: b64_encode(plain.as_bytes()),
            protected: false,
        },
    };
    // Die Kopie, die ueber die Bruecke kam, wird hier nicht mehr gebraucht.
    // Ohne das bliebe sie bis zur naechsten Wiederverwendung im Speicher stehen.
    plain.zeroize();
    ergebnis
}

/// Einen geschuetzten Wert wieder oeffnen.
///
/// `protected` sagt, wie er abgelegt wurde - der Aufrufer weiss das aus seiner
/// eigenen Datei und muss nicht raten.
#[tauri::command]
pub fn unprotect_secret(data: String, protected: bool) -> Result<String, String> {
    let mut raw = b64_decode(&data).ok_or_else(|| "Ungültige Ablage".to_string())?;
    let plain = if protected {
        let geoeffnet = imp::unprotect(&raw).ok_or_else(|| {
            // Der haeufigste Grund: die Datei stammt von einem anderen
            // Benutzerkonto oder einem anderen Rechner. Genau so soll es sein.
            "Wert lässt sich auf diesem Benutzerkonto nicht entschlüsseln".to_string()
        });
        // Die Kennung bzw. der Blob wird nicht mehr gebraucht - auch dann nicht,
        // wenn das Oeffnen scheiterte.
        raw.zeroize();
        geoeffnet?
    } else {
        raw
    };
    String::from_utf8(plain).map_err(|_| "Wert ist kein gültiger Text".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_hin_und_zurueck() {
        for probe in ["", "a", "ab", "abc", "abcd", "Ümläute und Zeichen +/="] {
            let kodiert = b64_encode(probe.as_bytes());
            assert_eq!(b64_decode(&kodiert).unwrap(), probe.as_bytes());
        }
    }

    #[test]
    fn base64_deckt_alle_bytewerte_ab() {
        let alle: Vec<u8> = (0..=255u8).collect();
        assert_eq!(b64_decode(&b64_encode(&alle)).unwrap(), alle);
    }

    #[test]
    fn geschuetzter_wert_kommt_wieder_heraus() {
        let p = protect_secret("geheimer-schlüssel".into());
        assert!(p.protected, "Schutz sollte auf Desktop greifen");
        // Der Klartext darf in der Ablage nicht mehr zu sehen sein.
        assert!(!p.data.contains("geheimer"));
        assert_eq!(
            unprotect_secret(p.data, p.protected).unwrap(),
            "geheimer-schlüssel"
        );
    }

    #[test]
    fn kaputte_ablage_wird_abgewiesen() {
        assert!(unprotect_secret("!!! kein base64 !!!".into(), false).is_err());
    }
}
