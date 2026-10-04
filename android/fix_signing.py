with open('android/app/build.gradle', encoding='utf-8') as f:
    c = f.read()

# Add signing config before buildTypes
old = '    buildTypes {'
new = """    signingConfigs {
        release {
            storeFile file('../qca-release-key.jks')
            storePassword System.getenv('QCA_STORE_PASS') ?: 'qca2026'
            keyAlias 'qca'
            keyPassword System.getenv('QCA_KEY_PASS') ?: 'qca2026'
        }
    }

    buildTypes {"""

if 'signingConfigs' not in c:
    c = c.replace(old, new, 1); print("OK signing config added")
else:
    print("Already has signingConfigs")

# Add signingConfig to release buildType
old2 = """        release {
            minifyEnabled true
            shrinkResources true
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'"""
new2 = """        release {
            signingConfig signingConfigs.release
            minifyEnabled true
            shrinkResources true
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'"""

if 'signingConfig signingConfigs.release' not in c:
    c = c.replace(old2, new2, 1); print("OK signingConfig added to release")

with open('android/app/build.gradle','w',encoding='utf-8') as f:
    f.write(c)
print("Done")
