//! W1 measurement only (removed after the numbers are in): how long does extracting the Windows
//! seed take single-threaded (what the shell does) versus split across threads?
#[cfg(windows)]
fn main() {
    use std::{env, fs, io, path::PathBuf, thread, time::Instant};
    let args: Vec<String> = env::args().collect();
    let (seed, dest, mode) = (
        PathBuf::from(&args[1]),
        PathBuf::from(&args[2]),
        args[3].clone(),
    );
    let _ = fs::remove_dir_all(&dest);
    fs::create_dir_all(&dest).unwrap();
    let start = Instant::now();
    let entries = if mode == "single" {
        let mut archive = zip::ZipArchive::new(fs::File::open(&seed).unwrap()).unwrap();
        let entries = archive.len();
        archive.extract(&dest).unwrap();
        entries
    } else {
        let threads: usize = mode.parse().unwrap();
        let entries = zip::ZipArchive::new(fs::File::open(&seed).unwrap())
            .unwrap()
            .len();
        let workers: Vec<_> = (0..threads)
            .map(|worker| {
                let (seed, dest) = (seed.clone(), dest.clone());
                thread::spawn(move || {
                    let mut archive = zip::ZipArchive::new(fs::File::open(&seed).unwrap()).unwrap();
                    for index in (worker..archive.len()).step_by(threads) {
                        let mut entry = archive.by_index(index).unwrap();
                        let Some(relative) = entry.enclosed_name() else {
                            continue;
                        };
                        let target = dest.join(relative);
                        if entry.is_dir() {
                            fs::create_dir_all(&target).unwrap();
                            continue;
                        }
                        fs::create_dir_all(target.parent().unwrap()).unwrap();
                        io::copy(&mut entry, &mut fs::File::create(&target).unwrap()).unwrap();
                    }
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        entries
    };
    println!(
        "{mode}\t{entries} entries\t{:.2}s\t{}",
        start.elapsed().as_secs_f64(),
        dest.display()
    );
}

#[cfg(not(windows))]
fn main() {}
