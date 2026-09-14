import os, sys, shutil, tarfile, zipfile, urllib.request, json

headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}

def download(url, dest):
    print(f"Downloading {url} -> {dest}")
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req) as resp, open(dest, 'wb') as out:
        shutil.copyfileobj(resp, out)

def get_latest_url(repo, match_fn):
    req = urllib.request.Request(f"https://api.github.com/repos/{repo}/releases/latest", headers=headers)
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode())
        for asset in data.get("assets", []):
            name = asset["name"]
            if match_fn(name):
                return asset["browser_download_url"], name
    raise RuntimeError(f"No asset matched for {repo}")

os.makedirs("/tmp/installer", exist_ok=True)
os.chdir("/tmp/installer")

# 1. ProjectDiscovery tools: subfinder, httpx, dnsx
pd_tools = ["subfinder", "httpx", "dnsx"]
for tool in pd_tools:
    if shutil.which(tool):
        print(f"{tool} already installed")
        continue
    try:
        url, name = get_latest_url(f"projectdiscovery/{tool}", lambda n: "linux_amd64" in n and n.endswith(".zip"))
        download(url, name)
        with zipfile.ZipFile(name, 'r') as z:
            z.extract(tool, "/tmp/installer")
        os.system(f"sudo mv /tmp/installer/{tool} /usr/local/bin/{tool} && sudo chmod +x /usr/local/bin/{tool}")
        print(f"Installed {tool}")
    except Exception as e:
        print(f"Failed to install {tool}: {e}")

# 2. amass
if not shutil.which("amass"):
    try:
        url, name = get_latest_url("owasp-amass/amass", lambda n: ("linux_amd64" in n.lower()) and (n.endswith(".tar.gz") or n.endswith(".zip")))
        download(url, name)
        if name.endswith(".zip"):
            with zipfile.ZipFile(name, 'r') as z:
                z.extractall("/tmp/installer/amass_dir")
        else:
            with tarfile.open(name, 'r:gz') as t:
                t.extractall("/tmp/installer/amass_dir")
        for root, dirs, files in os.walk("/tmp/installer/amass_dir"):
            if "amass" in files:
                os.system(f"sudo mv {os.path.join(root, 'amass')} /usr/local/bin/amass && sudo chmod +x /usr/local/bin/amass")
                break
        print("Installed amass")
    except Exception as e:
        print(f"Failed to install amass: {e}")

# 3. feroxbuster
if not shutil.which("feroxbuster"):
    try:
        url, name = get_latest_url("epi052/feroxbuster", lambda n: ("linux" in n.lower() and "feroxbuster" in n.lower()) and (n.endswith(".tar.gz") or n.endswith(".zip")))
        download(url, name)
        if name.endswith(".zip"):
            with zipfile.ZipFile(name, 'r') as z:
                z.extractall("/tmp/installer/ferox_dir")
        else:
            with tarfile.open(name, 'r:gz') as t:
                t.extractall("/tmp/installer/ferox_dir")
        for root, dirs, files in os.walk("/tmp/installer/ferox_dir"):
            if "feroxbuster" in files:
                os.system(f"sudo mv {os.path.join(root, 'feroxbuster')} /usr/local/bin/feroxbuster && sudo chmod +x /usr/local/bin/feroxbuster")
                break
        print("Installed feroxbuster")
    except Exception as e:
        print(f"Failed to install feroxbuster: {e}")

# 4. searchsploit (exploitdb)
if not shutil.which("searchsploit"):
    try:
        if not os.path.exists("/opt/exploitdb"):
            os.system("sudo git clone --depth 1 https://gitlab.com/exploit-database/exploitdb.git /opt/exploitdb")
        os.system("sudo ln -sf /opt/exploitdb/searchsploit /usr/local/bin/searchsploit && sudo chmod +x /usr/local/bin/searchsploit")
        print("Installed searchsploit")
    except Exception as e:
        print(f"Failed to install searchsploit: {e}")

# 5. enum4linux
if not shutil.which("enum4linux"):
    try:
        download("https://raw.githubusercontent.com/CiscoCXSecurity/enum4linux/master/enum4linux.pl", "/tmp/installer/enum4linux")
        os.system("sudo mv /tmp/installer/enum4linux /usr/local/bin/enum4linux && sudo chmod +x /usr/local/bin/enum4linux")
        print("Installed enum4linux")
    except Exception as e:
        print(f"Failed to install enum4linux: {e}")

# 6. wpscan
if not shutil.which("wpscan"):
    print("Installing wpscan via gem...")
    os.system("sudo gem install --no-document wpscan || sudo apt-get install -y ruby-dev build-essential libcurl4-openssl-dev && sudo gem install --no-document wpscan || true")

shutil.rmtree("/tmp/installer", ignore_errors=True)
print("INSTALLATION FINISHED")
