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
        let mut inp = input(plain);
        let mut out = Blob::empty();
        let ok = unsafe {
            CryptProtectData(
                &mut inp,
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
        let mut inp = input(sealed);
        let mut out = Blob::empty();
        let ok = unsafe {
            CryptUnprotectData(
                &mut inp,
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

/// Ausserhalb von Windows der Schluesselbund des Systems: Keychain unter macOS,
/// Secret Service unter Linux.
///
/// Anders als DPAPI gibt ein Schluesselbund nichts zurueck, was man ablegen
/// koennte - er verwahrt selbst. Deshalb wandert der Wert dorthin, und in die
/// Datei kommt nur die Kennung, unter der er dort liegt. Eine kopierte Datei ist
/// damit genauso wertlos wie unter Windows.
///
/// Schlaegt es fehl (Linux ohne laufenden Secret Service, verweigerte Keychain),
/// gibt es `None` - der Aufrufer legt dann im Klartext ab und sagt es ehrlich.
#[cfg(all(not(windows), any(target_os = "macos", target_os = "linux")))]
mod imp {
    /// Unter diesem Namen taucht der Eintrag im Schluesselbund auf.
    const DIENST: &str = "TimeTracker";

    /// Eine Kennung, die es noch nicht gibt. Aus der Systemzeit und Zufall.
    fn neue_kennung() -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        let zeit = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        // Die Adresse einer frischen Allokation als zweite Quelle - sie
        // unterscheidet zwei Aufrufe in derselben Nanosekunde.
        let streu = Box::into_raw(Box::new(0u8)) as usize;
        let s = format!("{zeit:x}-{streu:x}");
        unsafe { drop(Box::from_raw(streu as *mut u8)) };
        s
    }

    pub fn protect(plain: &[u8]) -> Option<Vec<u8>> {
        let kennung = neue_kennung();
        let eintrag = keyring::Entry::new(DIENST, &kennung).ok()?;
        eintrag.set_secret(plain).ok()?;
        Some(kennung.into_bytes())
    }

    pub fn unprotect(sealed: &[u8]) -> Option<Vec<u8>> {
        let kennung = std::str::from_utf8(sealed).ok()?;
        let eintrag = keyring::Entry::new(DIENST, kennung).ok()?;
        eintrag.get_secret().ok()
    }
}

/// Alles Uebrige (BSD, unbekannte Ziele): kein Schutz, und das wird gesagt.
///
/// Bewusst keine eigene Bastelloesung - eine Verschluesselung mit dem Schluessel
/// daneben schuetzt vor nichts und taeuscht Sicherheit vor.
#[cfg(all(not(windows), not(any(target_os = "macos", target_os = "linux"))))]
mod imp {
    pub fn protect(_plain: &[u8]) -> Option<Vec<u8>> {
        None
    }
    pub fn unprotect(_sealed: &[u8]) -> Option<Vec<u8>> {
        None
    }
}

fn b64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
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
    for c in text.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\n' | b'\r' => continue,
            _ => return None,
        } as u32;
        acc = (acc << 6) | v;
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

    #[cfg(windows)]
    #[test]
    fn geschuetzter_wert_kommt_wieder_heraus() {
        let p = protect_secret("geheimer-schlüssel".into());
        assert!(p.protected, "DPAPI sollte auf Windows greifen");
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
