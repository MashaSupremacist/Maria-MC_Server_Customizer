import java.io.BufferedReader;
import java.io.InputStreamReader;

/** Tiny stdin/stdout probe used before attempting to host Minecraft. */
public final class MscProcessProbe {
    private MscProcessProbe() {}

    public static void main(String[] args) throws Exception {
        System.out.println("READY");
        System.out.flush();
        BufferedReader input = new BufferedReader(new InputStreamReader(System.in));
        String line;
        while ((line = input.readLine()) != null) {
            if ("STOP".equalsIgnoreCase(line.trim())) {
                System.out.println("STOPPED");
                System.out.flush();
                return;
            }
            System.out.println("ECHO:" + line);
            System.out.flush();
        }
    }
}
