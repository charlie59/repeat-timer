import UIKit
import Capacitor

/// Registers the app's own native plugins (timer + StoreKit billing).
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(TimerPlugin())
        bridge?.registerPluginInstance(BillingPlugin())
    }
}
